const Cc = Components.classes;
const CC = Components.Constructor;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
const { SystemAppProxy } = Cu.import("resource://gre/modules/SystemAppProxy.jsm");

const DEBUG = true;
const REMOTE_CONTROL_EVENT = 'remote-control-event';

function debug (message)
{
  if (DEBUG) {
    dump(message + '\n');
  }
}

function handleClickEvent (event)
{
  let type = 'navigator:browser';
  let shell = Services.wm.getMostRecentWindow(type);
  let document = shell.document;
  let systemApp = document.getElementsByTagName("HTML:IFRAME")[0];
  var domWindowUtils = shell.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                     .getInterface(Components.interfaces.nsIDOMWindowUtils);

  var x = isNaN(getState("x")) ? 0 : parseInt(getState("x"));
  var y = isNaN(getState("y")) ? 0 : parseInt(getState("y"));

  ["mousedown",  "mouseup"].forEach(function(mouseType) {
    // On b2g-desktop, we should subtract diff from window to screen position
    domWindowUtils.sendMouseEvent (mouseType, x, y, 0, 1, 0);
   });
}

function handleTouchEvent (event)
{
  let type = 'navigator:browser';
  let shell = Services.wm.getMostRecentWindow(type);
  let document = shell.document;
  let systemApp = document.getElementsByTagName("HTML:IFRAME")[0];
  var domWindowUtils = shell.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                     .getInterface(Components.interfaces.nsIDOMWindowUtils);

  var x = isNaN(getState("x")) ? 0 : parseInt(getState("x"));
  var y = isNaN(getState("y")) ? 0 : parseInt(getState("y"));
  var startX = 0;
  var startY = 0;

  switch (event.type) {
    case "touchstart":
      startX = x;
      startY = y;
      setState("startX", startX.toString());
      setState("startY", startY.toString());
      break;
    case "touchmove":
    case "touchend":
      startX = parseInt(getState("startX"));
      startY = parseInt(getState("startY"));
      break;
    default:
      return;
  }

  let detail = event.detail;
  x = startX + detail.dx * 2;
  y = startY + detail.dy * 2;

  x = x < 0 ? 0 : x;
  x = x > shell.innerWidth ? shell.innerWidth : x;

  y = y < 0 ? 0 : y;
  y = y > shell.innerHeight ? shell.innerHeight : y;

  setState ("x", x.toString());
  setState ("y", y.toString());

  domWindowUtils.sendMouseEvent ("mousemove", x, y, 0, 0, 0);
  // Use SystemAppProxy send
  SystemAppProxy._sendCustomEvent(REMOTE_CONTROL_EVENT, {
    action: 'move-cursor',
    state: event.type.substring(5),
    x: x,
    y: y
  });
}

function handleKeyboardEvent (keyCodeName)
{
  debug('key: ' + keyCodeName);

  const nsIDOMKeyEvent = Ci.nsIDOMKeyEvent;
  let type = "navigator:browser";
  let shell = Services.wm.getMostRecentWindow(type);

  var utils = shell.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
                     .getInterface(Components.interfaces.nsIDOMWindowUtils);

  ["keydown",  "keypress", "keyup"].forEach(function(keyType) {
    var keyCode = nsIDOMKeyEvent[keyCodeName];
    var modifiers = 0;
    var happened = utils.sendKeyEvent(keyType, keyCode, 0, modifiers);
  });
}

function handleInputEvent (detail)
{
  debug('input: ' + JSON.stringify(detail));

  let sysApp = SystemAppProxy.getFrame().contentWindow;
  let mozIM = sysApp.navigator.mozInputMethod;
  let icChangeTimeout = null;

  function icChangeHandler() {
    mozIM.removeEventListener('inputcontextchange', icChangeHandler);
    if (icChangeTimeout) {
      sysApp.clearTimeout(icChangeTimeout);
      icChangeTimeout = null;
    }

    let inputcontext = mozIM.inputcontext;
    if (inputcontext) {
      if (detail.clear) {
        lengthBeforeCursor = inputcontext.textBeforeCursor.length;
        lengthAfterCursor = inputcontext.textAfterCursor.length;
        inputcontext.deleteSurroundingText(
          -1 * lengthBeforeCursor,
          lengthBeforeCursor + lengthAfterCursor
        );
      }

      if (detail.string) {
        inputcontext.setComposition(detail.string);
        inputcontext.endComposition(detail.string);
      }

      if (detail.keycode) {
        inputcontext.sendKey(detail.keycode);
      }
    } else {
      debug('ERROR: No inputcontext!');
    }

    mozIM.setActive(false);
    SystemAppProxy._sendCustomEvent(REMOTE_CONTROL_EVENT, {
      action: 'grant-input',
      value: false
    });
  }

  SystemAppProxy._sendCustomEvent(REMOTE_CONTROL_EVENT, {
    action: 'grant-input',
    value: true
  });
  mozIM.setActive(true);
  mozIM.addEventListener('inputcontextchange', icChangeHandler);
  icChangeTimeout = sysApp.setTimeout(icChangeHandler, 1000);
}

function handleRequest(request, response)
{
  var queryString = decodeURIComponent(request.queryString.replace(/\+/g, "%20"));

  response.setHeader("Content-Type", "text/html", false);
  //response.write(queryString);

  // Split JSON header "message="
  var event = JSON.parse(queryString.substring(8));

  switch (event.type) {
    case "echo":
      debug(event.detail);
      break;
    case "keypress":
      handleKeyboardEvent(event.detail);
      break;
    case "touchstart":
    case "touchmove":
    case "touchend":
      debug(JSON.stringify(event));
      handleTouchEvent (event);
      break;
    case "click":
      debug(JSON.stringify(event));
      handleClickEvent (event);
      break;
    case "input":
      handleInputEvent(event.detail);
      break;
  }
}
