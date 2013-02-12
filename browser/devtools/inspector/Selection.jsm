/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const Cu = Components.utils;
const Ci = Components.interfaces;
Cu.import("resource:///modules/devtools/EventEmitter.jsm");

this.EXPORTED_SYMBOLS = ["Selection"];

/**
 * API
 *
 *   new Selection(node=null, track={attributes,detached});
 *   destroy()
 *   node (readonly)
 *   setNode(node, origin="unknown")
 *
 * Helpers:
 *
 *   window
 *   document
 *   isRoot()
 *   isNode()
 *   isHTMLNode()
 *
 * Check the nature of the node:
 *
 *   isElementNode()
 *   isAttributeNode()
 *   isTextNode()
 *   isCDATANode()
 *   isEntityRefNode()
 *   isEntityNode()
 *   isProcessingInstructionNode()
 *   isCommentNode()
 *   isDocumentNode()
 *   isDocumentTypeNode()
 *   isDocumentFragmentNode()
 *   isNotationNode()
 *
 * Events:
 *   "new-node" when the inner node changed
 *   "before-new-node" when the inner node is set to change
 *   "attribute-changed" when an attribute is changed (only if tracked)
 *   "detached" when the node (or one of its parents) is removed from the document (only if tracked)
 *   "reparented" when the node (or one of its parents) is moved under a different node (only if tracked)
 */

/**
 * A Selection object. Hold a reference to a node.
 * Includes some helpers, fire some helpful events.
 *
 * @param node Inner node.
 *    Can be null. Can be (un)set in the future via the "node" property;
 * @param trackAttribute Tell if events should be fired when the attributes of
 *    the ndoe change.
 *
 */
this.Selection = function Selection(walker, node=null, track={attributes:true,detached:true}) {
  EventEmitter.decorate(this);
  this._onMutations = this._onMutations.bind(this);
  this.setWalker(walker);
  this.track = track;
  this.setNodeRef(node);
}

Selection.prototype = {
  _nodeRef: null,

  setWalker: function(walker) {
    // XXX: probably need to clear out the current stuff...

    if (this.walker) {
      this.walker.off("mutations", this._onMutations);
    }

    this.walker = walker;
    this._attachEvents();
  },

  _onMutations: function(eventName, mutations) {
    let attributeChange = false;
    let detached = false;
    let parentNode = null;
    for (let m of mutations) {
      if (m.target == this.nodeRef && !attributeChange && m.type == "attributes") {
        attributeChange = true;
      }
      if (m.type == "childList") {
        if (!detached && !this.isConnected()) {
          parentNode = m.target;
          detached = true;
        }
      }
    }

    if (attributeChange)
      this.emit("attribute-changed");
    if (detached)
      this.emit("detached", parentNode);
  },

  _attachEvents: function SN__attachEvents() {
    if (!this.isNode() || !this.track || !this.walker) {
      return;
    }

    if (this.track.attributes || this.track.detached) {
      this.walker.on("mutations", this._onMutations);
    }
  },

  _detachEvents: function SN__detachEvents() {
    if (this.walker) {
      this.walker.off("mutations", this._onMutations);
    }
  },

  destroy: function SN_destroy() {
    this._detachEvents();
    this.setNodeRef(null, "destroy");
  },

  setRawNode: function SN_setRawNode(value, reason="unknown") {
    this.setNodeRef(value ? this.walker.importRaw(value) : null, reason);
  },

  setNodeRef: function SN_setNodeRef(value, reason="unknown") {
    this.reason = reason;
    if (value !== this._nodeRef) {
      this.emit("before-new-node", value, reason);
      let previousNode = this._nodeRef;
      this._detachEvents();
      this._nodeRef = value;
      this._attachEvents();
      // XXX: switch the notification over to nodeRefs.
      this.emit("new-node", previousNode, this.reason);
    }
  },

  // Well-behaved modules can start using that now.
  get rawNode() {
    return this.nodeRef ? this.nodeRef.rawNode : null;
  },

  // ... and this should change to node.
  get nodeRef() {
    return this._nodeRef;
  },

  get document() {
    discouraged();
    return this.rawDocument;
  },

  get rawDocument() {
    if (this.isNode()) {
      return this.rawNode.ownerDocument;
    }
    return null;
  },

  isRoot: function SN_isRootNode() {
    return this.isNode() &&
           this.isConnected() &&
           this.nodeRef.isDocumentElement();
  },

  isNode: function SN_isNode() {
    return this.nodeRef && this.nodeRef.isNode();
  },

  isConnected: function SN_isConnected() {
    return this.nodeRef && this.nodeRef.isConnected();
  },

  isHTMLNode: function SN_isHTMLNode() {
    let xhtml_ns = "http://www.w3.org/1999/xhtml";
    return this.isNode() && this.nodeRef.namespaceURI == xhtml_ns;
  },

  // Node type

  isElementNode: function SN_isElementNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.ELEMENT_NODE;
  },

  isAttributeNode: function SN_isAttributeNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.ATTRIBUTE_NODE;
  },

  isTextNode: function SN_isTextNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.TEXT_NODE;
  },

  isCDATANode: function SN_isCDATANode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.CDATA_SECTION_NODE;
  },

  isEntityRefNode: function SN_isEntityRefNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.ENTITY_REFERENCE_NODE;
  },

  isEntityNode: function SN_isEntityNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.ENTITY_NODE;
  },

  isProcessingInstructionNode: function SN_isProcessingInstructionNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.PROCESSING_INSTRUCTION_NODE;
  },

  isCommentNode: function SN_isCommentNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.PROCESSING_INSTRUCTION_NODE;
  },

  isDocumentNode: function SN_isDocumentNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.DOCUMENT_NODE;
  },

  isDocumentTypeNode: function SN_isDocumentTypeNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.DOCUMENT_TYPE_NODE;
  },

  isDocumentFragmentNode: function SN_isDocumentFragmentNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.DOCUMENT_FRAGMENT_NODE;
  },

  isNotationNode: function SN_isNotationNode() {
    return this.isNode() && this.nodeRef.nodeType == Ci.nsIDOMNode.NOTATION_NODE;
  },
}
