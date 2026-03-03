import type {
  Exchange,
  Operation,
  OperationResult,
  RequestPolicy,
  CacheOutcome,
} from '@urql/core';
import { formatDocument, makeOperation } from '@urql/core';

import type { Source } from 'wonka';
import {
  filter,
  map,
  merge,
  pipe,
  share,
  fromArray,
  fromPromise,
  mergeMap,
  empty,
} from 'wonka';

import { _query } from './operations/query';
import { _write } from './operations/write';
import { addMetadata, toRequestPolicy } from './helpers/operation';
import { filterVariables, getMainOperation } from './ast';
import { Store } from './store/store';
import type { Data, Dependencies, CacheExchangeOpts } from './types';

import {
  initDataState,
  clearDataState,
  noopDataState,
  hydrateData,
  reserveLayer,
  hasLayer,
  scheduleGC,
} from './store/data';
import { setOptimizeForJSC, createKeyMap, createKeySet } from './store/dataStructures';
import { resetFieldKeyCache } from './store/keys';

interface OperationResultWithMeta extends Partial<OperationResult> {
  operation: Operation;
  outcome: CacheOutcome;
  dependencies: Dependencies;
  hasNext: boolean;
}

type Operations = Set<number>;
type OperationMap = Map<number, Operation>;
type OptimisticDependencies = Map<number, Dependencies>;
type DependentOperations = Map<string, Operations>;

/** Exchange factory that creates a normalized cache exchange.
 *
 * @param opts - A {@link CacheExchangeOpts} configuration object.
 * @returns the created normalized cache {@link Exchange}.
 *
 * @remarks
 * Graphcache is a normalized cache, enabled by using the `cacheExchange`
 * in place of `@urql/core`’s. A normalized GraphQL cache uses typenames
 * and key fields in the result to share a single copy for each unique
 * entity across all queries.
 *
 * The `cacheExchange` may be passed a {@link CacheExchangeOpts} object
 * to define custom resolvers, custom updates for mutations,
 * optimistic updates, or to add custom key fields per type.
 *
 * @see {@link https://urql.dev/goto/docs/graphcache} for the full Graphcache docs.
 */
export const cacheExchange =
  <C extends Partial<CacheExchangeOpts>>(opts?: C): Exchange =>
  ({ forward, client, dispatchDebug }) => {
    setOptimizeForJSC(!!opts?.optimizeForJSC);
    resetFieldKeyCache();
    const store = new Store<C>(opts);
    let hydrationPromise: Promise<void> | undefined;

    if (opts && opts.storage) {
      store.data.hydrating = true;
      hydrationPromise = opts.storage.readData().then(entries => {
        hydrateData(store.data, opts!.storage!, entries);
        if (opts.storage!.onCacheHydrated) opts.storage!.onCacheHydrated();
      });
    }

    const optimisticKeysToDependencies: OptimisticDependencies = createKeyMap() as any;
    const mutationResultBuffer: OperationResult[] = [];
    const operations: OperationMap = createKeyMap() as any;
    const blockedDependencies: Dependencies = createKeySet() as any;
    const requestedRefetch: Operations = createKeySet() as any;
    const deps: DependentOperations = createKeyMap() as any;
    store.data.operations = operations as unknown as Map<number, unknown>;
    store.data.deps = deps;

    let reexecutingOperations: Operations = createKeySet() as any;
    let dependentOperations: Operations = createKeySet() as any;

    const isBlockedByOptimisticUpdate = (
      dependencies: Dependencies | null
    ): boolean => {
      if (!dependencies) return false;
      for (const dep of dependencies.values())
        if (blockedDependencies.has(dep)) return true;
      return false;
    };

    const collectPendingOperations = (
      pendingOperations: Operations | null,
      dependencies: undefined | Dependencies | null
    ) => {
      if (pendingOperations && dependencies) {
        for (const dep of dependencies.values()) {
          const keys = deps.get(dep);
          if (keys) for (const key of keys.values()) pendingOperations.add(key);
        }
      }
    };

    const executePendingOperations = (
      operation: Operation,
      pendingOperations: Operations,
      isOptimistic: boolean
    ) => {
      // Reexecute collected operations and delete them from the mapping
      for (const key of pendingOperations.values()) {
        if (key !== operation.key) {
          const op = operations.get(key);
          if (op) {
            // Collect all dependent operations if the reexecuting operation is a query
            if (operation.kind === 'query') dependentOperations.add(key);
            let policy: RequestPolicy = 'cache-first';
            if (requestedRefetch.has(key)) {
              requestedRefetch.delete(key);
              policy = 'cache-and-network';
            }
            client.reexecuteOperation(toRequestPolicy(op, policy));
          }
        }
      }

      if (!isOptimistic) {
        // Upon completion, all dependent operations become reexecuting operations, preventing
        // them from reexecuting prior operations again, causing infinite loops
        const _reexecutingOperations = reexecutingOperations;
        reexecutingOperations = dependentOperations;
        if (operation.kind === 'query') {
          reexecutingOperations.add(operation.key);
        }
        (dependentOperations = _reexecutingOperations).clear();
      }
    };

    // This registers queries with the data layer to ensure commutativity
    const prepareForwardedOperation = (operation: Operation) => {
      let optimistic = false;
      if (operation.kind === 'query') {
        // Pre-reserve the position of the result layer
        reserveLayer(store.data, operation.key);
        operations.set(operation.key, operation);
      } else if (operation.kind === 'teardown') {
        operations.delete(operation.key);
        reexecutingOperations.delete(operation.key);
        if (!store.data.disableLayers) {
          noopDataState(store.data, operation.key);
        }
        scheduleGC(store.data);
        return operation;
      } else if (
        operation.kind === 'mutation' &&
        operation.context.requestPolicy !== 'network-only'
      ) {
        operations.set(operation.key, operation);
        initDataState('write', store.data, operation.key, true, false, operation);
        const { dependencies } = _write(
          store,
          operation as any,
          undefined,
          undefined
        );
        clearDataState();
        if (dependencies.size) {
          // Update blocked optimistic dependencies
          for (const dep of dependencies.values()) blockedDependencies.add(dep);
          // Store optimistic dependencies for update
          optimisticKeysToDependencies.set(operation.key, dependencies);
          const pendingOperations: Operations = createKeySet() as any;
          collectPendingOperations(pendingOperations, dependencies);
          executePendingOperations(operation, pendingOperations, true);
          // Mark operation as optimistic
          optimistic = true;
        }
      }

      return makeOperation(
        operation.kind,
        {
          key: operation.key,
          query: formatDocument(operation.query),
          variables: operation.variables
            ? filterVariables(
                getMainOperation(operation.query),
                operation.variables
              )
            : operation.variables,
        },
        { ...operation.context, optimistic }
      );
    };

    // This updates the known dependencies for the passed operation
    const updateDependencies = (op: Operation, dependencies: Dependencies | null) => {
      if (!dependencies) return;
      for (const dep of dependencies.values()) {
        let depOps = deps.get(dep);
        if (!depOps) deps.set(dep, (depOps = createKeySet() as any));
        depOps.add(op.key);
      }
    };

    // Retrieves a query result from cache and adds an `isComplete` hint
    // This hint indicates whether the result is "complete" or not
    const operationResultFromCache = (
      operation: Operation
    ): OperationResultWithMeta => {
      initDataState('read', store.data, undefined, false, false, operation);
      const result = _query(
        store,
        operation,
        null,
        undefined,
        operation.context as { partialPolicy?: boolean }
      );
      clearDataState();
      const cacheOutcome: CacheOutcome = result.data
        ? !result.partial && !result.hasNext
          ? 'hit'
          : 'partial'
        : 'miss';

      operations.set(operation.key, operation);
      updateDependencies(operation, result.dependencies);

      return {
        outcome: cacheOutcome,
        operation,
        data: result.data,
        dependencies: result.dependencies,
        hasNext: result.hasNext,
      };
    };

    // Take any OperationResult and update the cache with it
    const updateCacheWithResult = (
      result: OperationResult,
      pendingOperations: Operations
    ): OperationResult => {
      // Retrieve the original operation to get unfiltered variables
      const operation =
        operations.get(result.operation.key) || result.operation;
      if (operation.kind === 'mutation') {
        const dependencies = optimisticKeysToDependencies.get(operation.key);
        if (pendingOperations) {
          collectPendingOperations(pendingOperations, dependencies);
        }
        optimisticKeysToDependencies.delete(operation.key);
      }

      if (operation.kind === 'subscription' || result.hasNext)
        reserveLayer(store.data, operation.key, true);

      let queryDependencies: undefined | Dependencies | null;
      let data: Data | null = result.data;
      if (data) {
        initDataState('write', store.data, operation.key, false, false, operation);
        const writeDependencies = _write(
          store,
          operation,
          data,
          result.error
        ).dependencies;
        clearDataState();
        if (pendingOperations && writeDependencies) {
          collectPendingOperations(pendingOperations, writeDependencies);
        }
        const prevData = null;
        initDataState(
          'read',
          store.data,
          operation.key,
          false,
          prevData !== data,
          operation
        );
        const queryResult = _query(
          store,
          operation,
          prevData || data,
          result.error,
          operation.context as { partialPolicy?: boolean }
        );
        clearDataState();
        data = queryResult.data;
        if (operation.kind === 'query') {
          queryDependencies = queryResult.dependencies;
          collectPendingOperations(pendingOperations, queryDependencies);
        }
      } else {
        noopDataState(store.data, operation.key);
      }

      // Update this operation's dependencies if it's a query
      if (queryDependencies) {
        updateDependencies(result.operation, queryDependencies);
      }

      return {
        operation,
        data,
        error: result.error,
        extensions: result.extensions,
        hasNext: result.hasNext,
        stale: result.stale,
      };
    };

    return operations$ => {
      const incomingOps$ =
        opts?.syncHydrate && hydrationPromise
          ? pipe(
              fromPromise(hydrationPromise),
              mergeMap(() => operations$)
            )
          : operations$;

      // Filter by operations that are cacheable and attempt to query them from the cache
      const cacheOps$ = pipe(
        incomingOps$,
        filter(
          op =>
            op.kind === 'query' && op.context.requestPolicy !== 'network-only'
        ),
        map(operationResultFromCache),
        share
      );

      const nonCacheOps$ = pipe(
        incomingOps$,
        filter(
          op =>
            op.kind !== 'query' || op.context.requestPolicy === 'network-only'
        )
      );

      // Rebound operations that are incomplete, i.e. couldn't be queried just from the cache
      const cacheMissOps$ = pipe(
        cacheOps$,
        filter(
          res =>
            res.outcome === 'miss' &&
            res.operation.context.requestPolicy !== 'cache-only' &&
            !isBlockedByOptimisticUpdate(res.dependencies) &&
            !reexecutingOperations.has(res.operation.key)
        ),
        map(res => {
          dispatchDebug({
            type: 'cacheMiss',
            message: 'The result could not be retrieved from the cache',
            operation: res.operation,
          });
          return addMetadata(res.operation, { cacheOutcome: 'miss' });
        })
      );

      // Resolve OperationResults that the cache was able to assemble completely and trigger
      // a network request if the current operation's policy is cache-and-network
      const cacheResult$ = pipe(
        cacheOps$,
        filter(
          res =>
            res.outcome !== 'miss' ||
            res.operation.context.requestPolicy === 'cache-only'
        ),
        map((res: OperationResultWithMeta): OperationResult => {
          const { requestPolicy } = res.operation.context;

          // We reexecute requests marked as `cache-and-network`, and partial responses,
          // if we wouldn't cause a request loop
          const shouldReexecute =
            requestPolicy !== 'cache-only' &&
            (res.hasNext ||
              requestPolicy === 'cache-and-network' ||
              (requestPolicy === 'cache-first' &&
                res.outcome === 'partial' &&
                !reexecutingOperations.has(res.operation.key)));
          // Set stale to true anyway, even if the reexecute will be blocked, if the operation
          // is in progress. We can be reasonably sure of that if a layer has been reserved for it.
          const stale =
            requestPolicy !== 'cache-only' &&
            (shouldReexecute ||
              (res.outcome === 'partial' &&
                reexecutingOperations.has(res.operation.key) &&
                hasLayer(store.data, res.operation.key)));

          const result: OperationResult = {
            operation: addMetadata(res.operation, {
              cacheOutcome: res.outcome,
            }),
            data: res.data,
            error: res.error,
            extensions: res.extensions,
            stale: stale && !res.hasNext,
            hasNext: shouldReexecute && res.hasNext,
          };

          if (!shouldReexecute) {
            /*noop*/
          } else if (!isBlockedByOptimisticUpdate(res.dependencies)) {
            client.reexecuteOperation(
              toRequestPolicy(
                operations.get(res.operation.key) || res.operation,
                'network-only'
              )
            );
          } else if (requestPolicy === 'cache-and-network') {
            requestedRefetch.add(res.operation.key);
          }

          dispatchDebug({
            type: 'cacheHit',
            message: `A requested operation was found and returned from the cache.`,
            operation: res.operation,
            data: {
              value: result,
            },
          });

          return result;
        })
      );

      // Forward operations that aren't cacheable and rebound operations
      // Also update the cache with any network results
      const result$ = pipe(
        merge([nonCacheOps$, cacheMissOps$]),
        map(prepareForwardedOperation),
        forward
      );

      // Results that can immediately be resolved
      const nonOptimisticResults$ = pipe(
        result$,
        filter(
          result => !optimisticKeysToDependencies.has(result.operation.key)
        ),
        map(result => {
          const notifyOnWrite = result.operation.context.notifyOnWrite;
          const shouldNotify = notifyOnWrite !== undefined ? notifyOnWrite :
            (result.operation.kind === 'mutation' || result.operation.kind === 'query');
          const pendingOperations: Operations | null = shouldNotify ? createKeySet() as any : null;
          if (process.env.NODE_ENV !== 'production' && !pendingOperations) {
            dispatchDebug({
              type: 'skipUpdates',
              message: `We skipped propogated updates for this operation`,
              operation: result.operation,
              data: { value: result },
              source: 'cacheExchange',
            } as any);
          }
          const cacheResult = updateCacheWithResult(result, pendingOperations as any);
          if (pendingOperations) executePendingOperations(result.operation, pendingOperations, false);
          return cacheResult;
        })
      );

      // Prevent mutations that were previously optimistic from being flushed
      // immediately and instead clear them out slowly
      const optimisticMutationCompletion$ = pipe(
        result$,
        filter(result =>
          optimisticKeysToDependencies.has(result.operation.key)
        ),
        mergeMap((result: OperationResult): Source<OperationResult> => {
          const length = mutationResultBuffer.push(result);
          if (length < optimisticKeysToDependencies.size) {
            return empty;
          }

          for (let i = 0; i < mutationResultBuffer.length; i++) {
            reserveLayer(store.data, mutationResultBuffer[i].operation.key);
          }

          blockedDependencies.clear();

          const results: OperationResult[] = [];
          const pendingOperations: Operations = createKeySet() as any;

          let bufferedResult: OperationResult | void;
          while ((bufferedResult = mutationResultBuffer.shift()))
            results.push(
              updateCacheWithResult(bufferedResult, pendingOperations)
            );

          // Execute all dependent queries as a single batch
          executePendingOperations(result.operation, pendingOperations, false);

          return fromArray(results);
        })
      );

      return merge([
        nonOptimisticResults$,
        optimisticMutationCompletion$,
        cacheResult$,
      ]);
    };
  };
