/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("chrome://marionette/content/atom.js");
Cu.import("chrome://marionette/content/error.js");

/**
 * The ElementManager manages DOM element references and
 * interactions with elements.
 *
 * A web element is an abstraction used to identify an element when it
 * is transported across the protocol, between remote- and local ends.
 *
 * Each element has an associated web element reference (a UUID) that
 * uniquely identifies the the element across all browsing contexts. The
 * web element reference for every element representing the same element
 * is the same.
 *
 * The element manager provides a mapping between web element references
 * and DOM elements for each browsing context.  It also provides
 * functionality for looking up and retrieving elements.
 */

this.EXPORTED_SYMBOLS = [
  "element",
  "ElementManager",
  "CLASS_NAME",
  "SELECTOR",
  "ID",
  "NAME",
  "LINK_TEXT",
  "PARTIAL_LINK_TEXT",
  "TAG",
  "XPATH",
  "ANON",
  "ANON_ATTRIBUTE"
];

const DOCUMENT_POSITION_DISCONNECTED = 1;

const uuidGen = Cc["@mozilla.org/uuid-generator;1"]
    .getService(Ci.nsIUUIDGenerator);

this.CLASS_NAME = "class name";
this.SELECTOR = "css selector";
this.ID = "id";
this.NAME = "name";
this.LINK_TEXT = "link text";
this.PARTIAL_LINK_TEXT = "partial link text";
this.TAG = "tag name";
this.XPATH = "xpath";
this.ANON= "anon";
this.ANON_ATTRIBUTE = "anon attribute";

this.ElementManager = function ElementManager(notSupported) {
  this.seenItems = {};
  this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  this.elementStrategies = [CLASS_NAME, SELECTOR, ID, NAME, LINK_TEXT, PARTIAL_LINK_TEXT, TAG, XPATH, ANON, ANON_ATTRIBUTE];
  for (let i = 0; i < notSupported.length; i++) {
    this.elementStrategies.splice(this.elementStrategies.indexOf(notSupported[i]), 1);
  }
}

ElementManager.prototype = {
  /**
   * Reset values
   */
  reset: function EM_clear() {
    this.seenItems = {};
  },

  /**
  * Add element to list of seen elements
  *
  * @param nsIDOMElement element
  *        The element to add
  *
  * @return string
  *        Returns the server-assigned reference ID
  */
  addToKnownElements: function EM_addToKnownElements(el) {
    for (let i in this.seenItems) {
      let foundEl = null;
      try {
        foundEl = this.seenItems[i].get();
      } catch (e) {}
      if (foundEl) {
        if (XPCNativeWrapper(foundEl) == XPCNativeWrapper(el)) {
          return i;
        }
      } else {
        // cleanup reference to GC'd element
        delete this.seenItems[i];
      }
    }
    let id = element.generateUUID();
    this.seenItems[id] = Cu.getWeakReference(el);
    return id;
  },

  /**
   * Retrieve element from its unique ID
   *
   * @param String id
   *        The DOM reference ID
   * @param nsIDOMWindow, ShadowRoot container
   *        The window and an optional shadow root that contains the element
   *
   * @returns nsIDOMElement
   *        Returns the element or throws Exception if not found
   */
  getKnownElement: function EM_getKnownElement(id, container) {
    let el = this.seenItems[id];
    if (!el) {
      throw new JavaScriptError(`Element has not been seen before. Id given was ${id}`);
    }
    try {
      el = el.get();
    }
    catch(e) {
      el = null;
      delete this.seenItems[id];
    }
    // use XPCNativeWrapper to compare elements; see bug 834266
    let wrappedFrame = XPCNativeWrapper(container.frame);
    let wrappedShadowRoot;
    if (container.shadowRoot) {
      wrappedShadowRoot = XPCNativeWrapper(container.shadowRoot);
    }

    if (!el ||
        !(XPCNativeWrapper(el).ownerDocument == wrappedFrame.document) ||
        this.isDisconnected(XPCNativeWrapper(el), wrappedShadowRoot,
          wrappedFrame)) {
      throw new StaleElementReferenceError(
          "The element reference is stale. Either the element " +
          "is no longer attached to the DOM or the page has been refreshed.");
    }
    return el;
  },

  /**
   * Check if the element is detached from the current frame as well as the
   * optional shadow root (when inside a Shadow DOM context).
   * @param nsIDOMElement el
   *        element to be checked
   * @param ShadowRoot shadowRoot
   *        an optional shadow root containing an element
   * @param nsIDOMWindow frame
   *        window that contains the element or the current host of the shadow
   *        root.
   * @return {Boolean} a flag indicating that the element is disconnected
   */
  isDisconnected: function EM_isDisconnected(el, shadowRoot, frame) {
    if (shadowRoot && frame.ShadowRoot) {
      if (el.compareDocumentPosition(shadowRoot) &
        DOCUMENT_POSITION_DISCONNECTED) {
        return true;
      }
      // Looking for next possible ShadowRoot ancestor
      let parent = shadowRoot.host;
      while (parent && !(parent instanceof frame.ShadowRoot)) {
        parent = parent.parentNode;
      }
      return this.isDisconnected(shadowRoot.host, parent, frame);
    } else {
      return el.compareDocumentPosition(frame.document.documentElement) &
        DOCUMENT_POSITION_DISCONNECTED;
    }
  },

  /**
   * Convert values to primitives that can be transported over the
   * Marionette protocol.
   *
   * This function implements the marshaling algorithm defined in the
   * WebDriver specification:
   *
   *     https://dvcs.w3.org/hg/webdriver/raw-file/tip/webdriver-spec.html#synchronous-javascript-execution
   *
   * @param object val
   *        object to be marshaled
   *
   * @return object
   *         Returns a JSON primitive or Object
   */
  wrapValue: function EM_wrapValue(val) {
    let result = null;

    switch (typeof(val)) {
      case "undefined":
        result = null;
        break;

      case "string":
      case "number":
      case "boolean":
        result = val;
        break;

      case "object":
        let type = Object.prototype.toString.call(val);
        if (type == "[object Array]" ||
            type == "[object NodeList]") {
          result = [];
          for (let i = 0; i < val.length; ++i) {
            result.push(this.wrapValue(val[i]));

          }
        }
        else if (val == null) {
          result = null;
        }
        else if (val.nodeType == 1) {
          let elementId = this.addToKnownElements(val);
          result = {[element.LegacyKey]: elementId, [element.Key]: elementId};
        }
        else {
          result = {};
          for (let prop in val) {
            result[prop] = this.wrapValue(val[prop]);
          }
        }
        break;
    }

    return result;
  },

  /**
   * Convert any ELEMENT references in 'args' to the actual elements
   *
   * @param object args
   *        Arguments passed in by client
   * @param nsIDOMWindow, ShadowRoot container
   *        The window and an optional shadow root that contains the element
   *
   * @returns object
   *        Returns the objects passed in by the client, with the
   *        reference IDs replaced by the actual elements.
   */
  convertWrappedArguments: function EM_convertWrappedArguments(args, container) {
    let converted;
    switch (typeof(args)) {
      case 'number':
      case 'string':
      case 'boolean':
        converted = args;
        break;
      case 'object':
        if (args == null) {
          converted = null;
        }
        else if (Object.prototype.toString.call(args) == '[object Array]') {
          converted = [];
          for (let i in args) {
            converted.push(this.convertWrappedArguments(args[i], container));
          }
        }
        else if (((typeof(args[element.LegacyKey]) === 'string') && args.hasOwnProperty(element.LegacyKey)) ||
                 ((typeof(args[element.Key]) === 'string') &&
                     args.hasOwnProperty(element.Key))) {
          let elementUniqueIdentifier = args[element.Key] ? args[element.Key] : args[element.LegacyKey];
          converted = this.getKnownElement(elementUniqueIdentifier, container);
          if (converted == null) {
            throw new WebDriverError(`Unknown element: ${elementUniqueIdentifier}`);
          }
        }
        else {
          converted = {};
          for (let prop in args) {
            converted[prop] = this.convertWrappedArguments(args[prop], container);
          }
        }
        break;
    }
    return converted;
  },

  /*
   * Execute* helpers
   */

  /**
   * Return an object with any namedArgs applied to it. Used
   * to let clients use given names when refering to arguments
   * in execute calls, instead of using the arguments list.
   *
   * @param object args
   *        list of arguments being passed in
   *
   * @return object
   *        If '__marionetteArgs' is in args, then
   *        it will return an object with these arguments
   *        as its members.
   */
  applyNamedArgs: function EM_applyNamedArgs(args) {
    let namedArgs = {};
    args.forEach(function(arg) {
      if (arg && typeof(arg['__marionetteArgs']) === 'object') {
        for (let prop in arg['__marionetteArgs']) {
          namedArgs[prop] = arg['__marionetteArgs'][prop];
        }
      }
    });
    return namedArgs;
  },

  /**
   * Find a single element or a collection of elements starting at the
   * document root or a given node.
   *
   * If |timeout| is above 0, an implicit search technique is used.
   * This will wait for the duration of |timeout| for the element
   * to appear in the DOM.
   *
   * See the |element.Strategies| enum for a full list of supported
   * search strategies that can be passed to |strategy|.
   *
   * Available flags for |opts|:
   *
   *     |all|
   *       If true, a multi-element search selector is used and a sequence
   *       of elements will be returned.  Otherwise a single element.
   *
   *     |timeout|
   *       Duration to wait before timing out the search.  If |all| is
   *       false, a NoSuchElementError is thrown if unable to find
   *       the element within the timeout duration.
   *
   *     |startNode|
   *       Element to use as the root of the search.
   *
   * @param {Object.<string, Window>} container
   *     Window object and an optional shadow root that contains the
   *     root shadow DOM element.
   * @param {string} strategy
   *     Search strategy whereby to locate the element(s).
   * @param {string} selector
   *     Selector search pattern.  The selector must be compatible with
   *     the chosen search |strategy|.
   * @param {Object.<string, ?>} opts
   *     Options.
   *
   * @return {Promise: (WebElement|Array<WebElement>)}
   *     Single element or a sequence of elements.
   *
   * @throws InvalidSelectorError
   *     If |strategy| is unknown.
   * @throws InvalidSelectorError
   *     If |selector| is malformed.
   * @throws NoSuchElementError
   *     If a single element is requested, this error will throw if the
   *     element is not found.
   */
  find: function(container, strategy, selector, opts = {}) {
    opts.all = !!opts.all;
    opts.timeout = opts.timeout || 0;

    let searchFn;
    if (opts.all) {
      searchFn = this.findElements.bind(this);
    } else {
      searchFn = this.findElement.bind(this);
    }

    return new Promise((resolve, reject) => {
      let findElements = implicitlyWaitFor(
          () => this.find_(container, strategy, selector, searchFn, opts),
          opts.timeout);

      findElements.then(foundEls => {
        // when looking for a single element and none is found,
        // an error must be thrown
        if (foundEls.length == 0 && !opts.all) {
          let msg;
          switch (strategy) {
            case ANON:
              msg = "Unable to locate anonymous children";
              break;

            case ANON_ATTRIBUTE:
              msg = "Unable to locate anonymous element: " + JSON.stringify(selector);
              break;

            default:
              msg = "Unable to locate element: " + selector;
          }

          reject(new NoSuchElementError(msg));
        }

        // serialise elements for return
        let rv = [];
        for (let el of foundEls) {
          let ref = this.addToKnownElements(el);
          let we = element.makeWebElement(ref);
          rv.push(we);
        }

        if (opts.all) {
          resolve(rv);
        }
        resolve(rv[0]);
      }, reject);
    });
  },

  find_: function(container, strategy, selector, searchFn, opts) {
    let rootNode = container.shadowRoot || container.frame.document;
    let startNode;
    if (opts.startNode) {
      startNode = this.getKnownElement(opts.startNode, container);
    } else {
      startNode = rootNode;
    }

    if (strategy in element.Strategies) {
      throw new InvalidSelectorError("No such strategy: " + strategy);
    }

    let res;
    try {
      res = searchFn(strategy, selector, rootNode, startNode);
    } catch (e) {
      throw new InvalidSelectorError(`Given ${strategy} expression "${selector}" is invalid`);
    }

    if (element.isElementCollection(res)) {
      return res;
    } else if (res !== null) {
      return [res];
    }
    return [];
  },

  /**
   * Find a value by XPATH
   *
   * @param nsIDOMElement root
   *        Document root
   * @param string value
   *        XPATH search string
   * @param nsIDOMElement node
   *        start node
   *
   * @return nsIDOMElement
   *        returns the found element
   */
  findByXPath: function EM_findByXPath(root, value, node) {
    return root.evaluate(value, node, null,
            Ci.nsIDOMXPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  },

  /**
   * Find values by XPATH
   *
   * @param nsIDOMElement root
   *        Document root
   * @param string value
   *        XPATH search string
   * @param nsIDOMElement node
   *        start node
   *
   * @return object
   *        returns a list of found nsIDOMElements
   */
  findByXPathAll: function EM_findByXPathAll(root, value, node) {
    let values = root.evaluate(value, node, null,
                      Ci.nsIDOMXPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    let elements = [];
    let element = values.iterateNext();
    while (element) {
      elements.push(element);
      element = values.iterateNext();
    }
    return elements;
  },

  /**
   * Finds a single element.
   *
   * @param {String} using
   *     Which selector search method to use.
   * @param {String} value
   *     Selector query.
   * @param {nsIDOMElement} rootNode
   *     Document root.
   * @param {nsIDOMElement=} startNode
   *     Optional node from which we start searching.
   *
   * @return {nsIDOMElement}
   *     Returns found element.
   * @throws {InvalidSelectorError}
   *     If the selector query string (value) is invalid, or the selector
   *     search method (using) is unknown.
   */
  findElement: function EM_findElement(using, value, rootNode, startNode) {
    let element;

    switch (using) {
      case ID:
        element = startNode.getElementById ?
                  startNode.getElementById(value) :
                  this.findByXPath(rootNode, `.//*[@id="${value}"]`, startNode);
        break;

      case NAME:
        element = startNode.getElementsByName ?
                  startNode.getElementsByName(value)[0] :
                  this.findByXPath(rootNode, `.//*[@name="${value}"]`, startNode);
        break;

      case CLASS_NAME:
        element = startNode.getElementsByClassName(value)[0]; //works for >=FF3
        break;

      case TAG:
        element = startNode.getElementsByTagName(value)[0]; //works for all elements
        break;

      case XPATH:
        element = this.findByXPath(rootNode, value, startNode);
        break;

      case LINK_TEXT:
      case PARTIAL_LINK_TEXT:
        let allLinks = startNode.getElementsByTagName('A');
        for (let i = 0; i < allLinks.length && !element; i++) {
          let text = allLinks[i].text;
          if (PARTIAL_LINK_TEXT == using) {
            if (text.indexOf(value) != -1) {
              element = allLinks[i];
            }
          } else if (text == value) {
            element = allLinks[i];
          }
        }
        break;
      case SELECTOR:
        try {
          element = startNode.querySelector(value);
        } catch (e) {
          throw new InvalidSelectorError(`${e.message}: "${value}"`);
        }
        break;

      case ANON:
        element = rootNode.getAnonymousNodes(startNode);
        if (element != null) {
          element = element[0];
        }
        break;

      case ANON_ATTRIBUTE:
        let attr = Object.keys(value)[0];
        element = rootNode.getAnonymousElementByAttribute(startNode, attr, value[attr]);
        break;

      default:
        throw new InvalidSelectorError(`No such strategy: ${using}`);
    }

    return element;
  },

  /**
   * Helper method to find. Finds all element using find's criteria
   *
   * @param string using
   *        String identifying which search method to use
   * @param string value
   *        Value to look for
   * @param nsIDOMElement rootNode
   *        Document root
   * @param nsIDOMElement startNode
   *        Node from which we start searching
   *
   * @return nsIDOMElement
   *        Returns found elements or throws Exception if not found
   */
  findElements: function EM_findElements(using, value, rootNode, startNode) {
    let elements = [];
    switch (using) {
      case ID:
        value = `.//*[@id="${value}"]`;
      case XPATH:
        elements = this.findByXPathAll(rootNode, value, startNode);
        break;
      case NAME:
        elements = startNode.getElementsByName ?
                   startNode.getElementsByName(value) :
                   this.findByXPathAll(rootNode, `.//*[@name="${value}"]`, startNode);
        break;
      case CLASS_NAME:
        elements = startNode.getElementsByClassName(value);
        break;
      case TAG:
        elements = startNode.getElementsByTagName(value);
        break;
      case LINK_TEXT:
      case PARTIAL_LINK_TEXT:
        let allLinks = startNode.getElementsByTagName('A');
        for (let i = 0; i < allLinks.length; i++) {
          let text = allLinks[i].text;
          if (PARTIAL_LINK_TEXT == using) {
            if (text.indexOf(value) != -1) {
              elements.push(allLinks[i]);
            }
          } else if (text == value) {
            elements.push(allLinks[i]);
          }
        }
        break;
      case SELECTOR:
        elements = Array.slice(startNode.querySelectorAll(value));
        break;
      case ANON:
        elements = rootNode.getAnonymousNodes(startNode) || [];
        break;
      case ANON_ATTRIBUTE:
        let attr = Object.keys(value)[0];
        let el = rootNode.getAnonymousElementByAttribute(startNode, attr, value[attr]);
        if (el != null) {
          elements = [el];
        }
        break;
      default:
        throw new InvalidSelectorError(`No such strategy: ${using}`);
    }
    return elements;
  },
};

/**
 * Runs function off the main thread until its return value is truthy
 * or the provided timeout is reached.  The function is guaranteed to be
 * run at least once, irregardless of the timeout.
 *
 * A truthy return value constitutes a truthful boolean, positive number,
 * object, or non-empty array.
 *
 * The |func| is evaluated every |interval| for as long as its runtime
 * duration does not exceed |interval|.  If the runtime evaluation duration
 * of |func| is greater than |interval|, evaluations of |func| are queued.
 *
 * @param {function(): ?} func
 *     Function to run off the main thread.
 * @param {number} timeout
 *     Desired timeout.  If 0 or less than the runtime evaluation time
 *     of |func|, |func| is guaranteed to run at least once.
 * @param {number=} interval
 *     Duration between each poll of |func| in milliseconds.  Defaults to
 *     100 milliseconds.
 *
 * @return {Promise}
 *     Yields the return value from |func|.  The promise is rejected if
 *     |func| throws.
 */
function implicitlyWaitFor(func, timeout, interval = 100) {
  let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

  return new Promise((resolve, reject) => {
    let startTime = new Date().getTime();
    let endTime = startTime + timeout;

    let observer = function() {
      let res;
      try {
        res = func();
      } catch (e) {
        reject(e);
      }

      // empty arrays evaluate to true in JS,
      // so we must first ascertan if the result is a collection
      //
      // we also return immediately if timeout is 0,
      // allowing |func| to be evaluated at least once
      let col = element.isElementCollection(res);
      if (((col && res.length > 0 ) || (!col && !!res)) ||
          (startTime == endTime || new Date().getTime() >= endTime)) {
        resolve(res);
      }
    };

    timer.init(observer, interval, Ci.nsITimer.TYPE_REPEATING_SLACK);

  // cancel timer and return result for yielding
  }).then(res => {
    timer.cancel();
    return res;
  });
};

this.element = {};

element.LegacyKey = "ELEMENT";
element.Key = "element-6066-11e4-a52e-4f735466cecf";

element.Strategies = {
  CLASS_NAME: 0,
  SELECTOR: 1,
  ID: 2,
  NAME: 3,
  LINK_TEXT: 4,
  PARTIAL_LINK_TEXT: 5,
  TAG: 6,
  XPATH: 7,
  ANON: 8,
  ANON_ATTRIBUTE: 9,
};

element.isElementCollection = function(seq) {
  if (seq === null) {
    return false;
  }

  const arrayLike = {
    "[object Array]": 0,
    "[object HTMLCollection]": 1,
    "[object NodeList]": 2,
  };

  let typ = Object.prototype.toString.call(seq);
  return typ in arrayLike;
};

element.makeWebElement = function(uuid) {
  return {
    [element.Key]: uuid,
    [element.LegacyKey]: uuid,
  };
};

element.generateUUID = function() {
  let uuid = uuidGen.generateUUID().toString();
  return uuid.substring(1, uuid.length - 1);
};

/**
 * This function generates a pair of coordinates relative to the viewport
 * given a target element and coordinates relative to that element's
 * top-left corner.
 *
 * @param {Node} node
 *     Target node.
 * @param {number=} x
 *     Horizontal offset relative to target.  Defaults to the centre of
 *     the target's bounding box.
 * @param {number=} y
 *     Vertical offset relative to target.  Defaults to the centre of
 *     the target's bounding box.
 */
// TODO(ato): Replicated from listener.js for the time being
element.coordinates = function(node, x = undefined, y = undefined) {
  let box = node.getBoundingClientRect();
  if (!x) {
    x = box.width / 2.0;
  }
  if (!y) {
    y = box.height / 2.0;
  }
  return {
    x: box.left + x,
    y: box.top + y,
  };
};

/**
 * This function returns true if the node is in the viewport.
 *
 * @param {Element} element
 *     Target element.
 * @param {number=} x
 *     Horizontal offset relative to target.  Defaults to the centre of
 *     the target's bounding box.
 * @param {number=} y
 *     Vertical offset relative to target.  Defaults to the centre of
 *     the target's bounding box.
 */
element.inViewport = function(el, x = undefined, y = undefined) {
  let win = el.ownerDocument.defaultView;
  let c = element.coordinates(el, x, y);
  let vp = {
    top: win.pageYOffset,
    left: win.pageXOffset,
    bottom: (win.pageYOffset + win.innerHeight),
    right: (win.pageXOffset + win.innerWidth)
  };

  return (vp.left <= c.x + win.pageXOffset &&
      c.x + win.pageXOffset <= vp.right &&
      vp.top <= c.y + win.pageYOffset &&
      c.y + win.pageYOffset <= vp.bottom);
};

/**
 * This function throws the visibility of the element error if the element is
 * not displayed or the given coordinates are not within the viewport.
 *
 * @param {Element} element
 *     Element to check if visible.
 * @param {Window} window
 *     Window object.
 * @param {number=} x
 *     Horizontal offset relative to target.  Defaults to the centre of
 *     the target's bounding box.
 * @param {number=} y
 *     Vertical offset relative to target.  Defaults to the centre of
 *     the target's bounding box.
 */
element.isVisible = function(el, x = undefined, y = undefined) {
  let win = el.ownerDocument.defaultView;

  // Bug 1094246: webdriver's isShown doesn't work with content xul
  if (!element.isXULElement(el) && !atom.isElementDisplayed(el, win)) {
    return false;
  }

  if (el.tagName.toLowerCase() == "body") {
    return true;
  }

  if (!element.inViewport(el, x, y)) {
    if (el.scrollIntoView) {
      el.scrollIntoView(false);
      if (!element.inViewport(el)) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
};

element.isXULElement = function(el) {
  let ns = atom.getElementAttribute(el, "namespaceURI");
  return ns.indexOf("there.is.only.xul") >= 0;
};
