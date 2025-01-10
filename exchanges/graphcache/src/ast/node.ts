import type {
  NamedTypeNode,
  NameNode,
  DirectiveNode,
  SelectionNode,
  SelectionSetNode,
  FieldNode,
  FragmentDefinitionNode,
} from '@0no-co/graphql.web';

import type { FormattedNode } from '@urql/core';
import type { RelayNode } from './traversal';
import type { NormalizationSelection } from 'relay-runtime';

export type SelectionSet = readonly FormattedNode<SelectionNode>[];

const EMPTY_DIRECTIVES: Record<string, DirectiveNode | undefined> = {};

/** Returns the directives dictionary of a given node */
export const getDirectives = (node: {
  _directives?: Record<string, DirectiveNode | undefined>;
}) => node._directives || EMPTY_DIRECTIVES;

/** Returns the name of a given node */
export const getName = (node: { name: NameNode }): string => node.name.value;

export const getFragmentTypeName = (node: FragmentDefinitionNode): string =>
  node.typeCondition.name.value;

/** Returns either the field's name or the field's alias */
export const getFieldAlias = (node: FieldNode): string =>
  node.alias ? node.alias.value : node.name.value;

const emptySelectionSet: SelectionSet = [];

/** Returns the SelectionSet for a given inline or defined fragment node */
export const getSelectionSet = (
  node:
    | {
        selectionSet?: FormattedNode<SelectionSetNode>;
      }
    | RelayNode
):
  | FormattedNode<SelectionSet>
  | readonly NormalizationSelection[]
  | undefined => {
  if ('selectionSet' in node) {
    return (
      node.selectionSet ? node.selectionSet.selections : emptySelectionSet
    ) as FormattedNode<SelectionSet>;
  } else if ('default' in node) {
    return node.default.operation.selections;
  }
};

export const getTypeCondition = (node: {
  typeCondition?: NamedTypeNode;
}): string | null =>
  node.typeCondition ? node.typeCondition.name.value : null;
