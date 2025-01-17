import React from "react";
import debounce from "lodash.debounce";
import {
  awaitNotify,
  notify,
  stopAwatingNotify,
  subscribe,
  Subscriptions,
  useSubscription,
} from "./subscription";
import { MessageFiber } from "../types";

export function getSubtreeIds(id: number, childrenMap: Map<number, number[]>) {
  const subtree = new Set<number>([id]);

  for (const id of subtree) {
    const children = childrenMap.get(id) || [];

    for (const childId of children) {
      subtree.add(childId);
    }
  }

  return subtree;
}

type SubscribeDescriptor = { prev: Set<number>; unsubscribe(): void };
export function subscribeSubtree(
  id: number,
  tree: Tree,
  fn: (added: number[], removed: number[]) => void
) {
  const subscriptions = new Map<number, SubscribeDescriptor>();
  const pendingAdded = new Set<number>();
  const pendingRemoved = new Set<number>();
  const notifyChanges = debounce(
    () => {
      if (pendingAdded.size === 0 && pendingRemoved.size === 0) {
        return;
      }

      const added = [...pendingAdded];
      const removed = [...pendingRemoved];

      pendingAdded.clear();
      pendingRemoved.clear();

      fn(added, removed);
    },
    1,
    { maxWait: 1 }
  );
  const remove = (id: number) => {
    if (!subscriptions.has(id)) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { prev, unsubscribe } = subscriptions.get(id)!;
    subscriptions.delete(id);
    unsubscribe();
    for (const id of prev) {
      remove(id);
    }

    pendingRemoved.add(id);
    pendingAdded.delete(id);
    notifyChanges();
  };
  const add = (id: number) => {
    if (subscriptions.has(id)) {
      return;
    }

    const descriptor = {
      prev: new Set(tree.getOrCreate(id).children),
      unsubscribe: tree.subscribeById(id, (node: TreeNode) => {
        const nextSet = new Set(node.children);

        for (const id of nextSet) {
          if (!descriptor.prev.has(id)) {
            add(id);
          }
        }

        for (const id of descriptor.prev) {
          if (!nextSet.has(id)) {
            remove(id);
          }
        }

        descriptor.prev = nextSet;
      }),
    };

    subscriptions.set(id, descriptor);

    for (const childId of descriptor.prev) {
      add(childId);
    }

    pendingAdded.add(id);
    pendingRemoved.delete(id);
    notifyChanges();
  };

  add(id);
  notifyChanges();
  notifyChanges.flush();

  return () => {
    for (const [id] of subscriptions) {
      remove(id);
    }

    notifyChanges.flush();
    notifyChanges.cancel();
  };
}

export function findDelta(prev: Set<number>, next: Set<number>) {
  const added = [];
  const removed = [];

  for (const id of next) {
    if (!prev.has(id)) {
      added.push(id);
    }
  }

  for (const id of prev) {
    if (!next.has(id)) {
      removed.push(id);
    }
  }
}
export class Tree {
  root: TreeNode = new TreeNode(0);
  nodes = new Map<number, TreeNode>([[0, this.root]]);
  subscriptions: Subscriptions<() => void> = new Set();

  getOrCreate(id: number): TreeNode {
    let node = this.nodes.get(id);

    if (node === undefined) {
      this.nodes.set(id, (node = new TreeNode(id)));
      awaitNotify(this);
    }

    return node;
  }

  has(id: number) {
    return this.nodes.has(id);
  }

  get(id: number) {
    return this.nodes.get(id);
  }

  add(id: number, parentId: number) {
    const node = this.getOrCreate(id);
    const parent = this.getOrCreate(parentId);

    node.parent = parent;
    awaitNotify(parent);
  }

  setFiber(id: number, fiber: MessageFiber) {
    const node = this.nodes.get(id);

    if (node !== undefined) {
      node.fiber = fiber;
      awaitNotify(this);
    }
  }

  delete(id: number) {
    const node = this.nodes.get(id);

    if (node === undefined) {
      return;
    }

    node.next = node.last;
    if (node.next) {
      node.next.prev = node;
    }

    for (const descendant of node.descendants()) {
      this.nodes.delete(descendant.id);
      stopAwatingNotify(descendant);
      descendant.reset(true);
    }

    if (node.parent) {
      awaitNotify(node.parent);
    }

    if (id !== 0) {
      this.nodes.delete(id);
      awaitNotify(this);
      stopAwatingNotify(node);
    }

    node.reset();
  }

  subscribe(fn: () => void) {
    return subscribe(this.subscriptions, fn);
  }
  notify() {
    notify(this.subscriptions);
  }

  subscribeById(id: number, fn: TreeNodeSubscription) {
    const node = this.getOrCreate(id);

    return node.subscribe(fn);
  }

  walk(
    fn: (node: TreeNode) => boolean | void,
    start: number | null = null,
    end: number | null = null
  ) {
    return this.root.walk(
      fn,
      start !== null ? this.nodes.get(start as number) : null,
      end !== null ? this.nodes.get(end as number) : null
    );
  }
  walkBack(
    fn: (node: TreeNode) => boolean | void,
    start: number | null = null,
    end: number | null = null
  ) {
    return this.root.walkBack(
      fn,
      start !== null ? this.nodes.get(start) : null,
      end !== null ? this.nodes.get(end) : null
    );
  }

  find(
    accept: (node: TreeNode) => boolean,
    start: number | null = null,
    roundtrip?: boolean
  ) {
    return this.root.find(
      accept,
      start !== null ? this.nodes.get(start as number) : null,
      roundtrip
    );
  }
  findBack(
    accept: (node: TreeNode) => boolean,
    start: number | null = null,
    roundtrip?: boolean
  ) {
    return this.root.findBack(
      accept,
      start !== null ? this.nodes.get(start as number) : null,
      roundtrip
    );
  }
}

type TreeNodeSubscription = (node: TreeNode) => void;
export class TreeNode {
  id: number;
  fiber: MessageFiber | null = null;

  #parent: TreeNode | null = null;
  #children: number[] | null = null;
  firstChild: TreeNode | null = null;
  lastChild: TreeNode | null = null;
  prevSibling: TreeNode | null = null;
  nextSibling: TreeNode | null = null;
  prev: TreeNode | null = null;
  next: TreeNode | null = null;

  subscriptions: Subscriptions<TreeNodeSubscription> = new Set();

  constructor(id: number) {
    this.id = id;
  }

  subscribe(fn: TreeNodeSubscription) {
    return subscribe(this.subscriptions, fn);
  }

  notify() {
    notify(this.subscriptions, this);
  }

  get parent(): TreeNode | null {
    return this.#parent;
  }
  set parent(newParent: TreeNode | null) {
    if (this.#parent === newParent) {
      return;
    }

    if (this.#parent !== null) {
      const oldParent = this.#parent;

      if (oldParent.firstChild === this) {
        oldParent.firstChild = this.nextSibling;
      }

      if (oldParent.lastChild === this) {
        oldParent.lastChild = this.prevSibling;
      }

      if (this.prevSibling !== null) {
        this.prevSibling.nextSibling = this.nextSibling;
      }

      if (this.nextSibling !== null) {
        this.nextSibling.prevSibling = this.prevSibling;
      }

      if (this.prev !== null) {
        this.prev.next = this.next;
      }

      if (this.next !== null) {
        this.next.prev = this.prev;
      }

      oldParent.#children = null;
    }

    if (newParent !== null) {
      const lastChild = newParent.lastChild;
      const prevNext = newParent.last || newParent;

      this.prevSibling = newParent.lastChild;
      newParent.lastChild = this;

      if (lastChild !== null) {
        lastChild.nextSibling = this;
      } else {
        newParent.firstChild = this;
      }

      if (prevNext.next !== null) {
        prevNext.next.prev = this;
      }

      this.next = prevNext.next;
      prevNext.next = this;
      this.prev = prevNext;

      newParent.#children = null;
    }

    this.#parent = newParent;
  }

  get last(): TreeNode | null {
    let cursor: TreeNode = this;

    while (cursor.lastChild !== null) {
      cursor = cursor.lastChild;
    }

    return cursor !== this ? cursor : null;
  }
  get nextSkipDescendant(): TreeNode | null {
    let cursor: TreeNode | null = this;

    while (cursor !== null) {
      if (cursor.nextSibling !== null) {
        return cursor.nextSibling;
      }

      cursor = cursor.parent;
    }

    return null;
  }

  walk(
    fn: (node: TreeNode) => boolean | void,
    start: TreeNode | null = null,
    end: TreeNode | null = null
  ) {
    let cursor: TreeNode | null = start || this;
    end = end || this.last;

    if (cursor !== this && fn(this) === true) {
      return this;
    }

    while (cursor !== null) {
      if (fn(cursor) === true) {
        return cursor;
      }

      if (cursor === end) {
        break;
      }

      cursor = cursor.next;
    }

    return null;
  }

  walkBack(
    fn: (node: TreeNode) => boolean | void,
    start: TreeNode | null = null,
    end: TreeNode | null = null
  ) {
    let cursor: TreeNode | null = start || this.last || this;
    end = end || this;

    while (cursor !== null) {
      if (fn(cursor) === true) {
        return cursor;
      }

      if (cursor === end) {
        break;
      }

      cursor = cursor.prev;
    }

    if (cursor !== this && fn(this) === true) {
      return this;
    }

    return null;
  }

  find(
    accept: (node: TreeNode) => boolean,
    start: TreeNode | null = null,
    roundtrip = true
  ) {
    if (start !== null && roundtrip) {
      return this.walk(accept, start) || this.walk(accept, null, start);
    }

    return this.walk(accept);
  }

  findBack(
    accept: (node: TreeNode) => boolean,
    start: TreeNode | null = null,
    roundtrip = true
  ) {
    if (start !== null && roundtrip) {
      return this.walkBack(accept, start) || this.walkBack(accept, null, start);
    }

    return this.walkBack(accept);
  }

  descendants() {
    const subtree: TreeNode[] = [];

    this.walk(node => {
      if (node !== this) {
        subtree.push(node);
      }
    });

    return subtree;
  }

  get children(): number[] {
    if (this.#children !== null) {
      return this.#children;
    }

    let cursor = this.firstChild;
    this.#children = [];

    while (cursor !== null) {
      this.#children.push(cursor.id);
      cursor = cursor.nextSibling;
    }

    return this.#children;
  }

  reset(hard = false) {
    if (hard) {
      this.#parent = null;
    } else {
      this.parent = null;
    }

    this.#children = null;
    this.firstChild = null;
    this.lastChild = null;
    this.prevSibling = null;
    this.nextSibling = null;
    this.prev = null;
    this.next = null;
  }
}

export function useTreeUpdateSubscription(tree: Tree) {
  const [state, setState] = React.useState(0);

  useSubscription(
    () => tree.subscribe(() => setState(state => state + 1)),
    [tree]
  );

  return state;
}
