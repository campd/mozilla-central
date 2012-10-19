/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ft=javascript ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["InspectorDefinition"];

const Cu = Components.utils;

Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "InspectorPanel", "resource:///modules/devtools/InspectorPanel.jsm");

const InspectorDefinition = {
  id: "inspector",
  icon: "chrome://browser/skin/devtools/tools-icons-small.png",
  url: "chrome://browser/content/devtools/inspector/inspector.xul",
  get label() {
    let strings = Services.strings.createBundle("chrome://browser/locale/devtools/inspector.properties");
    return strings.GetStringFromName("inspector.label");
  },

  isTargetSupported: function(target) {
    switch (target.type) {
      case DevTools.TargetType.TAB:
        return true;
      case DevTools.TargetType.REMOTE:
      case DevTools.TargetType.CHROME:
      default:
        return false;
    }
  },

  build: function(iframeWindow, toolbox, node) {
    return new InspectorPanel(iframeWindow, toolbox, node);
  }
};
