/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Some specific (certified) apps need to get access to certain Firefox Accounts
 * functionality that allows them to manage accounts (this is mostly sign up,
 * sign in, logout and delete) and get information about the currently existing
 * ones.
 *
 * This service listens for requests coming from these apps, triggers the
 * appropriate Fx Accounts flows and send reponses back to the UI.
 *
 * The communication mechanism is based in mozFxAccountsContentEvent (for
 * messages coming from the UI) and mozFxAccountsChromeEvent (for messages
 * sent from the chrome side) custom events.
 */

"use strict";

/* static functions */
const DEBUG = true;

function debug(aStr) {
  DEBUG && dump("TVRemoteControlService: " + aStr + "\n");
}

this.EXPORTED_SYMBOLS = ["TVRemoteControlService"];

const { classes: Cc, interfaces: Ci, utils: Cu, Constructor: CC } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const FileInputStream = CC("@mozilla.org/network/file-input-stream;1",
                          "nsIFileInputStream",
                          "init");
const BinaryInputStream = CC("@mozilla.org/binaryinputstream;1",
                          "nsIBinaryInputStream",
                          "setInputStream");
const BinaryOutputStream = CC("@mozilla.org/binaryoutputstream;1",
                          "nsIBinaryOutputStream",
                          "setOutputStream");
const ScriptableInputStream = CC("@mozilla.org/scriptableinputstream;1",
                          "nsIScriptableInputStream",
                          "init");

var gThreadManager = null;

const TVRC_STATIC_BLACKLIST = ['/client.html', '/pairing.html'];
const TVRC_SJS = ['/ajax.sjs', '/pairing.sjs'];

// For b2g-destkop, you need to fill ip address here to start http server correctly
const DEFAULT_IP_ADDR = "10.247.26.32";
const DEFAULT_PORT = 8080;

function NS_ASSERT(cond, msg)
{
  if (DEBUG && !cond)
  {
    dumpn("###!!!");
    dumpn("###!!! ASSERTION" + (msg ? ": " + msg : "!"));
    dumpn("###!!! Stack follows:");

    var stack = new Error().stack.split(/\n/);
    dumpn(stack.map(function(val) { return "###!!!   " + val; }).join("\n"));

    throw Cr.NS_ERROR_ABORT;
  }
}

this.TVRemoteControlService = {
  _httpServer: null,
  _state: {},
  _pin: null,
  _uuids: null, // uuid : expire_timestamp

  init: function() {
    debug ("init");

    this._httpServer = Components.classes["@mozilla.org/server/jshttp;1"]
                           .createInstance(Components.interfaces.nsIHttpServer);
    gThreadManager = Cc["@mozilla.org/thread-manager;1"].getService();

    try {
      this._httpServer.registerPrefixHandler("/", function(request, response) {
        TVRemoteControlService._handleRequest(request, response);
      });
    } catch (e) { debug (e.message);}

    this._uuids = new Map();
    // TODO: Read UUID from persistant setting storage
  },

  start: function(ipaddr, port) {
    debug ("start");
    var _port = port ? port : DEFAULT_PORT;

    if (ipaddr) {
      this._httpServer.identity.add ("http", ipaddr, _port);
      this._httpServer.start(_port);
    } else {
      var nm;
      try {
        nm = Cc["@mozilla.org/network/manager;1"].getService(Ci.nsINetworkManager);
      } catch (e) {}

      if (nm) {
        // in b2g, get activeNetworkInfo or addObserver
        if (nm.activeNetworkInfo) {
          let ipAddresses = {};
          let prefixs = {};
          let numOfIpAddresses = activeNetwork.getAddresses (ipAddresses, prefixs);

          this._httpServer.identity.add ("http", ipAddresses["value"], _port);
          this._httpServer.start(_port);
        } else {
          var observerService = Components.classes["@mozilla.org/observer-service;1"]
                      .getService(Components.interfaces.nsIObserverService);
          observerService.addObserver (this, "network-active-changed", false);
        }
      } else {
        // in b2g-desktop, use default
        var _ipaddr = ipaddr ? ipaddr : DEFAULT_IP_ADDR;

        this._httpServer.identity.add ("http", _ipaddr, _port);
        this._httpServer.start(_port);
      }
    }
  },

  stop: function() {
    this._httpServer.stop();
  },

  observe: function(subject, topic, data) {
    if (topic == "network-active-changed" && subject) {
      let activeNetwork = subject
      let ipAddresses = {};
      let prefixs = {};
      let numOfIpAddresses = activeNetwork.getAddresses (ipAddresses, prefixs);

      var observerService = Components.classes["@mozilla.org/observer-service;1"]
                      .getService(Components.interfaces.nsIObserverService);
      observerService.removeObserver (this, "network-active-changed");

      this.start(ipAddresses["value"]);
    }
  },

  _getState: function(path, k)
  {
    var state = this._state;
    if (path in state && k in state[path])
      return state[path][k];
    return "";
  },

  _setState: function(path, k, v)
  {
    if (typeof v !== "string")
      throw new Error("non-string value passed");
    var state = this._state;
    if (!(path in state))
      state[path] = {};
    state[path][k] = v;
  },

  _generateUUID: function() {
    var uuidGenerator = Components.classes["@mozilla.org/uuid-generator;1"]
                    .getService(Components.interfaces.nsIUUIDGenerator);
    var uuid = uuidGenerator.generateUUID();
    var uuidString = uuid.toString();
    this._uuids.set (uuidString, (new Date().getTime())+ 90*24*60*60*1000);
  },

  _isValidUUID: function(uuid) {
    return this._uuids.has(uuid);
  },

  _updateUUID: function(uuid, timestamp) {
    if (this.uuids.has(uuid)) {
      this._uuids.set(uuid, timestamp);
    }
  },

  _clearUUID: function(uuid) {
    if (this._uuids.has(uuid)) {
      this._uuids.delete(uuid);
    }
  },

  _clearAllUUID: function() {
    this._uuids.clear();
  },

  _zeroFill: function(number, width) {
    width -= number.toString().length;
    if ( width > 0 )
    {
      return new Array( width + (/\./.test( number ) ? 2 : 1) ).join( '0' ) + number;
    }
    return number + ""; // always return a string
  },

  _generatePIN: function() {
    this._pin = this._zeroFill (Math.floor(Math.random() * 10000), 4);
    return this._pin;
  },

  _getPIN: function() {
    return this._pin;
  },

  _clearPIN: function() {
    this._pin = null;
  },

  _isValidPath: function(path) {
    debug (path);
    if (path == '/') return true;
    if (path.indexOf("..") > -1) return false;

    // Using channel.open to check if static file exists
    try {
      var ioService = Components.classes["@mozilla.org/network/io-service;1"]
                    .getService(Components.interfaces.nsIIOService);
      var channel = ioService.newChannel("app://remote-control.gaiamobile.org/client" + path, null, null);
      var fis = channel.open();
      fis.close();
      return true;
    } catch (e) { debug (e.message); }
    return false;
  },

  _handleRequest: function(request, response)
  {
    if (TVRC_STATIC_BLACKLIST.indexOf(request.path) >= 0)
      throw '500 Internal Server Error';
    else if (TVRC_SJS.indexOf(request.path) >= 0)
      this._handleSJSRequest(request, response);
    else if (this._isValidPath(request.path))
      this._handleStaticRequest(request, response);
    else
      throw '500 Internal Server Error';
  },

  _checkPathFromCookie: function(request) {
    /*
      if (request.path=='/' && request.hasHeader("Cookie")) {
         return this._isValidUUID (request.getHeader("Cookie")) ? "/client.html" : "/pairing.html";
    */
     if (request.path=='/' ) {
         return "/client.html";
     } else {
       return request.path;
     }
  },

  _handleStaticRequest: function(request, response)
  {
    const PR_RDONLY = 0x01;
    const PERMS_READONLY = (4 << 6) | (4 << 3) | 4;

    var ioService = Components.classes["@mozilla.org/network/io-service;1"]
                    .getService(Components.interfaces.nsIIOService);
    var path = this._checkPathFromCookie(request);
    var channel = ioService.newChannel("app://remote-control.gaiamobile.org/client" + path, null, null);
    var fis = channel.open();

    var offset = 0;
    var count = fis.available();

    response.setHeader("Content-Type", "text/html;charset=utf-8", false);
    //maybeAddHeaders(file, metadata, response);
    response.setHeader("Content-Length", "" + count, false);

    //offset = offset || 0;
    //count  = count || file.fileSize;

    //NS_ASSERT(offset === 0 || offset < file.fileSize, "bad offset");
    //NS_ASSERT(count >= 0, "bad count");
    //NS_ASSERT(offset + count <= file.fileSize, "bad total data size");

    try
    {
      if (offset !== 0)
      {
        // Seek (or read, if seeking isn't supported) to the correct offset so
        // the data sent to the client matches the requested range.
        if (fis instanceof Ci.nsISeekableStream)
          fis.seek(Ci.nsISeekableStream.NS_SEEK_SET, offset);
        else
          new ScriptableInputStream(fis).read(offset);
      }
    }
    catch (e)
    {
      fis.close();
      throw e;
    }

    let writeMore = function () {
      gThreadManager.currentThread
          .dispatch(writeData, Ci.nsIThread.DISPATCH_NORMAL);
    }

    var input = new BinaryInputStream(fis);
    var output = new BinaryOutputStream(response.bodyOutputStream);
    var writeData =
      {
        run: function()
        {
          var chunkSize = Math.min(65536, count);
          count -= chunkSize;
          NS_ASSERT(count >= 0, "underflow");

          try
          {
            var data = input.readByteArray(chunkSize);
            NS_ASSERT(data.length === chunkSize,
                      "incorrect data returned?  got " + data.length +
                      ", expected " + chunkSize);
            output.writeByteArray(data, data.length);
            if (count === 0)
            {
              fis.close();
              response.finish();
            }
            else
            {
              writeMore();
            }
          }
          catch (e)
          {
            try
            {
              fis.close();
            }
            finally
            {
              response.finish();
            }
            throw e;
          }
        }
      };

    writeMore();

    // Now that we know copying will start, flag the response as async.
    response.processAsync();
  },

  _handleSJSRequest: function(request, response)
  {
    var ioService = Components.classes["@mozilla.org/network/io-service;1"]
                    .getService(Components.interfaces.nsIIOService);
    var channel = ioService.newChannel("resource://gre/res/tvrc" + request.path, null, null);
    var fis = channel.open();

    try
    {
      var sis = new ScriptableInputStream(fis);
      var s = Cu.Sandbox (Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal));
      s.importFunction(dump, "dump");
      s.importFunction(atob, "atob");
      s.importFunction(btoa, "btoa");

      // Define a basic key-value state-preservation API across requests, with
      // keys initially corresponding to the empty string.
      var self = TVRemoteControlService;
      var path = request.path;
      s.importFunction(function getState(k)
      {
        return self._getState(path, k);
      });
      s.importFunction(function setState(k, v)
      {
        self._setState(path, k, v);
      });

      try
      {
        // Alas, the line number in errors dumped to console when calling the
        // request handler is simply an offset from where we load the SJS file.
        // Work around this in a reasonably non-fragile way by dynamically
        // getting the line number where we evaluate the SJS file.  Don't
        // separate these two lines!
        var line = new Error().lineNumber;
        Cu.evalInSandbox(sis.read(fis.available()), s, "latest");
      }
      catch (e)
      {
        dumpn("*** syntax error in SJS at " + channel.URI.path + ": " + e);
        throw "500 Internal Server Error";
      }

      try
      {
        s.handleRequest(request, response);
      }
      catch (e)
      {
        dump("*** error running SJS at " + channel.URI.path + ": " +
             e + " on line " +
             (e instanceof Error
              ? e.lineNumber + " in httpd.js"
              : (e.lineNumber - line)) + "\n");
        throw "500 Internal Server Error";
      }
    }
    finally
    {
      fis.close();
    }
  },
};

TVRemoteControlService.init();