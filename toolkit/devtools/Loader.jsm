const Cu = Components.utils;

this.EXPORTED_SYMBOLS = ["devtoolsRequire"];

let obj = {};
Cu.import('resource://gre/modules/commonjs/toolkit/loader.js', obj);
let {Loader, Require, unload} = obj.Loader;
let loader = new Loader({
  paths: {
    "sdk/": "resource://gre/modules/commonjs/sdk/",
    "devtools/toolkit/": 'resource://gre/modules/devtools/',
    "devtools/browser/": 'resource:///modules/devtools'
  }
});

this.devtoolsRequire = Require(loader, {id: "devtools"});
