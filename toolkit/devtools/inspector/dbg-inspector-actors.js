/* -*- Mode: js2; js2-basic-offset: 2; indent-tabs-mode: nil; -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let Cc = Components.classes;
let Ci = Components.interfaces;
let Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "DOMWalker",
                                  "resource:///modules/devtools/DOMWalker.jsm");


function InspectorActor(aConnection, aParentActor)
{
  this.conn = aConnection;

  if (aParentActor instanceof BrowserTabActor &&
      aParentActor.browser instanceof Ci.nsIDOMWindow) {
    this._window = aParentActor.browser;
  }
  else if (aParentActor instanceof BrowserTabActor &&
           aParentActor.browser instanceof Ci.nsIDOMElement) {
    this._window = aParentActor.browser.contentWindow;
  } else {
    // XXX: deal with this.
  }

  this._actorPool = new ActorPool(this.conn);
  this.conn.addActorPool(this._actorPool);
}

InspectorActor.prototype =
{
  /**
   * Actor pool for all of the actors we send to the client.
   * @private
   * @type object
   * @see ActorPool
   */
  _actorPool: null,

  /**
   * The debugger server connection instance.
   * @type object
   */
  conn: null,

  /**
   * The content window we work with.
   * @type nsIDOMWindow
   */
  get window() this._window,

  _window: null,

  actorPrefix: "inspector",

  grip: function IA_grip()
  {
    return { actor: this.actorID };
  },

  /**
   * Destroy the current InspectorActor instance.
   */
  disconnect: function IA_disconnect()
  {
    this.conn.removeActorPool(this.actorPool);
    this._actorPool = null;
    this.conn = this._window = null;
  },

  releaseActor: function IA_releaseActor(aActor)
  {
    if (this._actorPool) {
      this._actorPool.removeActor(aActor.actorID);
    }
  },

  onGetWalker: function IA_getWalker(aPacket)
  {
    let walker = new DOMWalker(this._window.document, {
      watchVisited: true
    });

    let actor = new DOMWalkerActor(this, walker);
    this._actorPool.addActor(actor);
    return actor.grip();
  },
};

InspectorActor.prototype.requestTypes =
{
  getWalker: InspectorActor.prototype.onGetWalker,
};

function DOMWalkerActor(aParentActor, aWalker)
{
  this.conn = aParentActor.conn;
  this.parent = aParentActor;
  this.walker = aWalker;
  this._actorPool = new ActorPool(this.conn);
  this.conn.addActorPool(this._actorPool);
  this._nodePool = new DOMNodePool(this);
  this.conn.addActorPool(this._nodePool);

  this._boundOnMutations = this._onMutations.bind(this);
  this.walker.on("mutations", this._boundOnMutations);

  this.sendError = function(error) {
    this.conn.send({
      from: this.actorID,
      error: "inspectorError",
      message: "DOM walker error:" + error.toString()
    })
  }.bind(this);
}

DOMWalkerActor.prototype = {
  actorPrefix: "domwalker",
  grip: function DWA_grip()
  {
    return { actor: this.actorID };
  },

  disconnect: function DWA_disconnect()
  {
    this.walker.off("mutations", this._boundOnMutations);
    delete this._boundOnMutations;

    this.walker.destroy();

    this.conn.removeActorPool(this._actorPool);
    delete this._actorPool;
    this.parent.releaseActor(this);
    delete this.conn;
    delete this.parent;
  },

  _nodeForm: function DWA_nodeForm(node)
  {
    return this._nodePool.fromNode(node).form();
  },

  _onMutations: function DWA_onMutations(event, mutations)
  {
    let toSend = [];
    for (let mutation of mutations) {
      if (!mutation.target.__actorID) {
        // This isn't a node we're monitoring.
        continue;
      }
      let target = mutation.target.__actorID;
      if (mutation.type == "childList") {
        toSend.push({
          target: target,
          type: "childList",
        });
      } else if (mutation.type == "attributes") {
        toSend.push({
          target: target,
          type: "attributes",
          attributeName: mutation.attributeName,
          attributeNamespace: mutation.attributeNamespace,
          oldValue: mutation.oldValue,
          newValue: mutation.target.rawNode.getAttribute(mutation.attributeName)
        });
      }
    }

    this.conn.send({
      from: this.actorID,
      type: "mutations",
      mutations: toSend
    });
  },

  onRoot: function DWA_onRoot(aPacket)
  {
    this.walker.root().then(function(root) {
      this.conn.send({
        from: this.actorID,
        root: this._nodeForm(root)
      });
    }.bind(this)).then(null, this.sendError);
  },

  onParents: function DWA_onChildren(aPacket)
  {
    let node = this._nodePool.node(aPacket.node);
    this.walker.parents(node, aPacket).then(function(parents) {
      this.conn.send({
        from: this.actorID,
        nodes: [this._nodeForm(parent) for (parent of parents)]
      });
    }.bind(this)).then(null, this.sendError);
  },

  onChildren: function DWA_onChildren(aPacket)
  {
    let node = this._nodePool.node(aPacket.node);
    this.walker.children(node, {
      include: aPacket.include ? this._nodePool.node(aPacket.include) : undefined,
      maxNodes: aPacket.maxNodes,
      whatToShow: aPacket.whatToShow
    }).then(function(children) {
      this.conn.send({
        from: this.actorID,
        hasFirst: children.hasFirst,
        hasLast: children.hasLast,
        nodes: [this._nodeForm(child) for (child of children.nodes)]
      });
    }.bind(this)).then(null, this.sendError);
  },

  onSiblings: function DWA_onChildren(aPacket)
  {
    let node = this._nodePool.node(aPacket.node);
    this.walker.siblings(node, {
      maxNodes: aPacket.maxNodes,
      whatToShow: aPacket.whatToShow
    }).then(function(children) {
      this.conn.send({
        from: this.actorID,
        hasFirst: children.hasFirst,
        hasLast: children.hasLast,
        nodes: [this._nodeForm(child) for (child of children.nodes)]
      });
    }.bind(this)).then(null, this.sendError);
  },

  _respondPseudoClasses: function(modified) {
    let nodes = [];
    for (let node of modified) {
      let actor = this._nodePool.nodeActor(node);
      nodes.push({
        actor: actor,
        pseudoClassLocks: node.pseudoClassLocks
      });
    }
    this.conn.send({
      from: this.actorID,
      nodes: nodes
    });
  },

  onAddPseudoClassLock: function DWA_onPseudoClassLock(aPacket)
  {
    let node = this._nodePool.node(aPacket.node);
    this.walker.addPseudoClassLock(node, aPacket.pseudo, {
      parents: aPacket.parents || undefined,
    }).then(function(modified) {
      this._respondPseudoClasses(modified);
    }.bind(this));
  },

  onRemovePseudoClassLock: function DWA_onPseudoClassLock(aPacket)
  {
    let node = this._nodePool.node(aPacket.node);
    this.walker.removePseudoClassLock(node, aPacket.pseudo, {
      parents: aPacket.parents || undefined,
    }).then(function(modified) {
      this._respondPseudoClasses(modified);
    }.bind(this));
  },
  onClearPseudoClassLocks: function DWA_onPseudoClassLock(aPacket)
  {
    let node = aPacket.node ? this._nodePool.node(aPacket.node) : null;
    this.walker.clearPseudoClassLocks(node, aPacket.pseudo, {
      all: aPacket.all || undefined,
    }).then(function(modified) {
      this._respondPseudoClasses(modified);
    }.bind(this));
  },

};

DOMWalkerActor.prototype.requestTypes = {
  root: DOMWalkerActor.prototype.onRoot,
  parents: DOMWalkerActor.prototype.onParents,
  children: DOMWalkerActor.prototype.onChildren,
  siblings: DOMWalkerActor.prototype.onSiblings,
  addPseudoClassLock: DOMWalkerActor.prototype.onAddPseudoClassLock,
  removePseudoClassLock: DOMWalkerActor.prototype.onRemovePseudoClassLock,
  clearPseudoClassLocks: DOMWalkerActor.prototype.onClearPseudoClassLocks,
};

// These are ephemeral, created as needed by the DOMWalkerNodePool.
function DOMNodeActor(aNodeRef, aActorID)
{
  this.nodeRef = aNodeRef;
  this.actorID = aNodeRef.__actorID;
}

DOMNodeActor.prototype = {
  form: function DNA_form() {
    let form = {
      actor: this.actorID
    };

    // XXX: some of these are redundant and should be worked out independently
    // on the client.

    for (let attr of [
      "id", "className", "numChildren",
      "nodeType", "namespaceURI", "tagName", "nodeName", "nodeValue",
      "name", "publicId", "systemId", "pseudoClassLocks"]) {
      form[attr] = this.nodeRef[attr];
    }

    for (let attr of [
      "isDocumentElement", "isNode", "isConnected"]) {
      form[attr] = this.nodeRef[attr]();
    }

    if (this.nodeRef.attributes) {
      let attrs = [];
      for (let i = 0; i < this.nodeRef.attributes.length; i++) {
        let attr = this.nodeRef.attributes[i];
        // XXX: namespace?
        attrs.push({name: attr.name, value: attr.value });
      }
      form.attrs = attrs;
    }

    if (this.nodeRef.isWalkerRoot()) {
      form.isWalkerRoot = true;
    }

    return form;
  }
}


function DOMNodePool(aActor) {
  this.walkerActor = aActor;
  this.idMap = new Map();
  // XXX: maybe we should just use this.conn.allocID...
  this.currentID = 0;
}

DOMNodePool.prototype = {
  fromNode: function(aNodeRef)  {
    if (!aNodeRef.__actorID) {
      aNodeRef.__actorID = this.walkerActor.actorID + "." + this.currentID++;
      this.idMap.set(aNodeRef.__actorID, aNodeRef);
    }

    return new DOMNodeActor(aNodeRef)
  },

  nodeActor: function(aNodeRef) {
    return aNodeRef.__actorID || this.fromNode(aNodeRef).actorID;
  },

  node: function DNP_node(aActorID) {
    return this.idMap.get(aActorID);
  },

  has: function DNP_has(aActorID) {
    return this.idMap.has(aActorID);
  },

  get: function DNP_get(aActorID) {
    return new DOMNodeActor(this.idMap.get(aActorID));
  },

  isEmpty: function DNP_isEmpty() {
    return this.idMap.size == 0;
  },

  cleanup: function DNP_cleanup() {
    this.idMap.clear();
  },
};
