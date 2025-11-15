'use strict';

const requireDir = require('./helpers/require-dir');
const path = require('path');
const request = require('sonos-discovery/lib/helpers/request');
const logger = require('sonos-discovery/lib/helpers/logger');
const HttpEventServer = require('./helpers/http-event-server');

function HttpAPI(discovery, settings) {
  const port = settings.port;
  const webroot = settings.webroot;
  const actions = {};
  const events = new HttpEventServer();

  this.getWebRoot = function () {
    return webroot;
  };

  this.getPort = function () {
    return port;
  };

  this.discovery = discovery;

  discovery.on('transport-state', function (player) {
    invokeWebhook('transport-state', player);
  });

  discovery.on('topology-change', function (topology) {
    invokeWebhook('topology-change', topology);
  });

  discovery.on('volume-change', function (volumeChange) {
    invokeWebhook('volume-change', volumeChange);
  });

  discovery.on('mute-change', function (muteChange) {
    invokeWebhook('mute-change', muteChange);
  });

  // this handles registering of all actions
  this.registerAction = function (action, handler) {
    actions[action] = handler;
  };

  //load modularized actions
  requireDir(path.join(__dirname, './actions'), (registerAction) => {
    registerAction(this);
  });

  this.requestHandler = function (req, res) {
    if (req.url === '/favicon.ico') {
      res.end();
      return;
    }

    if (req.url === '/events') {
      events.addClient(res);
      return;
    }

    function sendResponse(code, body) {
      const jsonResponse = JSON.stringify(body);
      res.statusCode = code;
      res.setHeader('Content-Length', Buffer.byteLength(jsonResponse));
      res.setHeader('Content-Type', 'application/json;charset=utf-8');
      res.write(Buffer.from(jsonResponse));
      res.end();
    }

    if (discovery.zones.length === 0) {
      const msg = 'No system has yet been discovered. Please see https://github.com/jishi/node-sonos-http-api/issues/77 if it doesn\'t resolve itself in a few seconds.';
      logger.error(msg);
      sendResponse(500, { status: 'error', error: msg });
      return;
    }

    const params = req.url.substring(1).split('/');

    // parse decode player name considering decode errors
    let players;
    try {
      const playersString = params[0];
      players = playersString.split('__').map(player => discovery.getPlayer(decodeURIComponent(player)));
    } catch (error) {
      logger.error(`Unable to parse supplied URI component (${params[0]})`, error);
      sendResponse(500, { status: 'error', error: error.message, stack: error.stack });
    }

    const promises = [];
    players.forEach((parsedPlayer) => {
      const opt = {};

      let player = parsedPlayer;
      if (player) {
        opt.action = (params[1] || '').toLowerCase();
        opt.values = params.slice(2);
      } else {
        player = discovery.getAnyPlayer();
        opt.action = (params[0] || '').toLowerCase();
        opt.values = params.slice(1);
      }

      opt.player = player;
      promises.push(handleAction(opt));
    });
    Promise.all(promises)
        .then((responses) => {
          let allIncoming = false;

          if (Array.isArray(responses) && responses.length > 0) {
            // Check if every response is an IncomingMessage
            allIncoming = responses.every(
                (res) => !res || res.constructor.name === 'IncomingMessage'
            );
          } else if (!responses || responses.constructor.name === 'IncomingMessage') {
            // Single response
            allIncoming = true;
          }

          // Set response based on check
          const finalResponse = allIncoming
              ? { status: 'success' }
              : { status: 'error', message: 'Not all responses qualified', details: responses };

          sendResponse(200, finalResponse);
        })
        .catch((error) => {
          logger.error(error);
          sendResponse(500, { status: 'error', error: error.message, stack: error.stack });
        });
  };


  function handleAction(options) {
    var player = options.player;

    if (!actions[options.action]) {
      return Promise.reject({ error: 'action \'' + options.action + '\' not found' });
    }

    return actions[options.action](player, options.values);


  }

  function invokeWebhook(type, data) {
    var typeName = "type";
    var dataName = "data";

    if (settings.webhookType) { typeName = settings.webhookType; }
    if (settings.webhookData) { dataName = settings.webhookData; }

    const jsonBody = JSON.stringify({
      [typeName]: type,
      [dataName]: data
    });

    events.sendEvent(jsonBody);

    if (!settings.webhook) return;

    const body = Buffer.from(jsonBody, 'utf8');

    var headers = {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    if (settings.webhookHeaderName && settings.webhookHeaderContents) {
      headers[settings.webhookHeaderName] = settings.webhookHeaderContents;
    }

    request({
      method: 'POST',
      uri: settings.webhook,
      headers: headers,
      body
    })
    .catch(function (err) {
      logger.error('Could not reach webhook endpoint', settings.webhook, 'for some reason. Verify that the receiving end is up and running.');
      logger.error(err);
    })
  }

}

module.exports = HttpAPI;
