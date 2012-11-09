/* vim:set ts=2 sw=2 sts=2 et: */
/*
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

function test() {
  var tab1 = addTab(TAB1_URL, function() {
    gBrowser.selectedTab = tab1;

    ok(!gDevTools.getPanelForTarget("jsdebugger", tab1),
      "Shouldn't have a debugger panel for this tab yet.");

    let toolbox = gDevTools.openToolboxForTab(tab1, "jsdebugger");
    toolbox.once("jsdebugger-ready", function dbgReady() {
      let dbg = gDevTools.getPanelForTarget("jsdebugger", tab1);
      ok(dbg, "We should have a debugger panel.");

      let someWidth1 = parseInt(Math.random() * 200) + 100;
      let someWidth2 = parseInt(Math.random() * 200) + 100;

      let content = dbg.panelWin;
      let stackframes;
      let variables;

      wait_for_connect_and_resume(function() {
        ok(content.Prefs.stackframesWidth,
          "The debugger preferences should have a saved stackframesWidth value.");
        ok(content.Prefs.variablesWidth,
          "The debugger preferences should have a saved variablesWidth value.");

        stackframes = content.document.getElementById("stackframes+breakpoints");
        variables = content.document.getElementById("variables");

        is(content.Prefs.stackframesWidth, stackframes.getAttribute("width"),
          "The stackframes pane width should be the same as the preferred value.");
        is(content.Prefs.variablesWidth, variables.getAttribute("width"),
          "The variables pane width should be the same as the preferred value.");

        stackframes.setAttribute("width", someWidth1);
        variables.setAttribute("width", someWidth2);

        removeTab(tab1);
      }, tab1);

      window.addEventListener("Debugger:Shutdown", function dbgShutdown() {
        window.removeEventListener("Debugger:Shutdown", dbgShutdown, true);

        is(content.Prefs.stackframesWidth, stackframes.getAttribute("width"),
          "The stackframes pane width should have been saved by now.");
        is(content.Prefs.variablesWidth, variables.getAttribute("width"),
          "The variables pane width should have been saved by now.");

        finish();

      }, true);
    });

  });
}
