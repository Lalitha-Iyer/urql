import {
  stableCopy,
  type NormalizationArgument,
  type ReaderArgument,
  type Variables,
} from 'relay-runtime';
import { RelayStoreUtils } from 'relay-runtime/lib/store/RelayStoreUtils';

/* Given Variables and a variable name, return a variable value with
 * all values in a stable order.
 */
function getStableVariableValue(name: string, variables: Variables): mixed {
  return stableCopy(variables[name]);
}

export function getArgumentValue(
  arg: NormalizationArgument | ReaderArgument,
  variables: Variables
): any {
  if (arg.kind === 'Variable') {
    // Variables are provided at runtime and are not guaranteed to be stable.
    return getStableVariableValue(arg.variableName, variables);
  } else if (arg.kind === 'Literal') {
    // The Relay compiler generates stable ConcreteArgument values.
    return arg.value;
  } else if (arg.kind === 'ObjectValue') {
    const value: { [string]: any } = {};
    arg.fields.forEach(field => {
      value[field.name] = getArgumentValue(field, variables);
    });
    return value;
  } else if (arg.kind === 'ListValue') {
    const value = [];
    arg.items.forEach(item => {
      item != null ? value.push(getArgumentValue(item, variables)) : null;
    });
    return value;
  }
}

/**
 * Returns the values of field/fragment arguments as an object keyed by argument
 * names. Guaranteed to return a result with stable ordered nested values.
 */
export function getArgumentValues(
  args?: ReadonlyArray<NormalizationArgument | ReaderArgument>,
  variables: Variables,
  isWithinUnmatchedTypeRefinement?: boolean
): Arguments {
  const values: {
    FRAGMENT_POINTER_IS_WITHIN_UNMATCHED_TYPE_REFINEMENT?: boolean;
    [string]: mixed;
  } = {};
  if (isWithinUnmatchedTypeRefinement) {
    values[
      RelayStoreUtils.FRAGMENT_POINTER_IS_WITHIN_UNMATCHED_TYPE_REFINEMENT
    ] = true;
  }
  if (args) {
    args.forEach(arg => {
      values[arg.name] = getArgumentValue(arg, variables);
    });
  }

  return values;
}
