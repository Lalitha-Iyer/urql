import type { FormattedNode, TypedDocumentNode } from '../types';

/** Formats a GraphQL document to add `__typename` fields and process client-side directives.
 *
 * @param node - a {@link DocumentNode}.
 * @returns a {@link FormattedDocument}
 *
 * @remarks
 * Cache {@link Exchange | Exchanges} will require typename introspection to
 * recognize types in a GraphQL response. To retrieve these typenames,
 * this function is used to add the `__typename` fields to non-root
 * selection sets of a GraphQL document.
 *
 * Additionally, this utility will process directives, filter out client-side
 * directives starting with an `_` underscore, and place a `_directives` dictionary
 * on selection nodes.
 *
 * This utility also preserves the internally computed key of the
 * document as created by {@link createRequest} to avoid any
 * formatting from being duplicated.
 *
 * @see {@link https://spec.graphql.org/October2021/#sec-Type-Name-Introspection} for more information
 * on typename introspection via the `__typename` field.
 */
export const formatDocument = <T extends TypedDocumentNode<any, any>>(
  node: T
): FormattedNode<T> => {
  return node as FormattedNode<T>;
};
