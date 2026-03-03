import { stringifyVariables } from '@urql/core';
import type { FieldArgs, FieldInfo, KeyInfo } from '../types';
import {
  createKeyMap,
  isOptimizeForJSCEnabled,
} from './dataStructures';

let fieldKeyCache = createKeyMap<string, string>();
let fieldKeyInternCounter = 0;

export const resetFieldKeyCache = () => {
  fieldKeyCache = createKeyMap<string, string>();
  fieldKeyInternCounter = 0;
};

export const keyOfField = (fieldName: string, args?: FieldArgs) => {
  if (!args) return fieldName;

  const fullKey = `${fieldName}(${stringifyVariables(args)})`;
  const cached = fieldKeyCache.get(fullKey);
  if (cached) return cached;

  const isConnectionField =
    fieldName.endsWith('connection') ||
    Object.prototype.hasOwnProperty.call(args, 'first') ||
    Object.prototype.hasOwnProperty.call(args, 'last') ||
    Object.prototype.hasOwnProperty.call(args, 'after') ||
    Object.prototype.hasOwnProperty.call(args, 'before');

  if (
    !isOptimizeForJSCEnabled() ||
    isConnectionField ||
    process.env.URQL_EXPLORER === 'true' ||
    process.env.NODE_ENV !== 'production'
  ) {
    fieldKeyCache.set(fullKey, fullKey);
    return fullKey;
  }

  const internedKey = `_k${fieldKeyInternCounter++}`;
  fieldKeyCache.set(fullKey, internedKey);
  return internedKey;
};

export const joinKeys = (parentKey: string, key: string) =>
  `${parentKey}.${key}`;

export const fieldInfoOfKey = (fieldKey: string): FieldInfo => {
  const parenIndex = fieldKey.indexOf('(');
  if (parenIndex > -1) {
    return {
      fieldKey,
      fieldName: fieldKey.slice(0, parenIndex),
      arguments: JSON.parse(fieldKey.slice(parenIndex + 1, -1)),
    };
  } else {
    return {
      fieldKey,
      fieldName: fieldKey,
      arguments: null,
    };
  }
};

export const serializeKeys = (entityKey: string, fieldKey: string) =>
  `${entityKey.replace(/\./g, '%2e')}.${fieldKey}`;

export const deserializeKeyInfo = (key: string): KeyInfo => {
  const dotIndex = key.indexOf('.');
  const entityKey = key.slice(0, dotIndex).replace(/%2e/g, '.');
  const fieldKey = key.slice(dotIndex + 1);
  return { entityKey, fieldKey };
};
