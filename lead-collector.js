/*
 * Lead Collector browser SDK.
 * Call LeadCollector.send() only from a confirmed host-form success handler.
 */
(function (global, document) {
    'use strict';

    var config = null;
    var attemptIds = new Map();
    var ATTEMPT_TTL_MS = 5 * 60 * 1000;
    var REQUIRED_CONFIG = ['projectId', 'endpoint', 'publicKey'];
    var UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

    function isNgrokFreeEndpoint(endpoint) {
        try {
            var hostname = new URL(endpoint).hostname.toLowerCase();
            return /^[^.]+\.ngrok-free\.(app|dev)$/.test(hostname);
        } catch (_) {
            return false;
        }
    }

    function text(value) {
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    }

    function debug() {
        if (config && config.debug && global.console && typeof global.console.warn === 'function') {
            global.console.warn.apply(global.console, arguments);
        }
    }

    function normalizeConfig(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        var normalized = {
            projectId: text(value.projectId),
            endpoint: text(value.endpoint),
            publicKey: text(value.publicKey),
            metrikaCounterId: value.metrikaCounterId || undefined,
            debug: value.debug === true,
        };
        if (REQUIRED_CONFIG.some(function (key) { return !normalized[key]; })) {
            return null;
        }
        try {
            var endpointUrl = new URL(normalized.endpoint);
            if (endpointUrl.protocol !== 'https:' && endpointUrl.protocol !== 'http:') {
                return null;
            }
            normalized.endpoint = endpointUrl.toString().replace(/\/$/, '');
        } catch (_) {
            return null;
        }
        return normalized;
    }

    function randomId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID().replace(/-/g, '');
        }
        if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
            var bytes = new Uint8Array(16);
            global.crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 15) | 64;
            bytes[8] = (bytes[8] & 63) | 128;
            return Array.prototype.map.call(bytes, function (byte, index) {
                var value = byte.toString(16).padStart(2, '0');
                return [4, 6, 8, 10].indexOf(index) >= 0 ? '-' + value : value;
            }).join('').replace(/-/g, '');
        }
        return 'lc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
    }

    function sourceId(value) {
        return text(value.leadId) || text(value.sourceLeadId) || text(value.source_lead_id);
    }

    function attemptFingerprint(value) {
        return JSON.stringify([
            text(value.name), text(value.phone), text(value.email), text(value.message),
            text(value.pageUrl), global.location && global.location.href,
        ]);
    }

    function generatedAttemptId(value) {
        var key = attemptFingerprint(value);
        var now = Date.now();
        var existing = attemptIds.get(key);
        if (existing && now - existing.createdAt < ATTEMPT_TTL_MS) {
            return existing.id;
        }
        var id = randomId();
        attemptIds.set(key, { id: id, createdAt: now });
        attemptIds.forEach(function (attempt, attemptKey) {
            if (now - attempt.createdAt >= ATTEMPT_TTL_MS) {
                attemptIds.delete(attemptKey);
            }
        });
        return id;
    }

    function queryValue(name) {
        try {
            return text(new URLSearchParams(global.location.search).get(name) || '');
        } catch (_) {
            return undefined;
        }
    }

    function cookie(name) {
        if (!document || !document.cookie) {
            return undefined;
        }
        var prefix = encodeURIComponent(name) + '=';
        var found = document.cookie.split('; ').find(function (item) { return item.indexOf(prefix) === 0; });
        return found ? text(decodeURIComponent(found.slice(prefix.length))) : undefined;
    }

    function clientId() {
        var fallback = cookie('_ym_uid');
        if (!config.metrikaCounterId || typeof global.ym !== 'function') {
            return Promise.resolve(fallback);
        }
        return new Promise(function (resolve) {
            var finished = false;
            var complete = function (value) {
                if (!finished) {
                    finished = true;
                    resolve(text(value) || fallback);
                }
            };
            var timer = global.setTimeout(function () { complete(fallback); }, 500);
            try {
                global.ym(config.metrikaCounterId, 'getClientID', function (value) {
                    global.clearTimeout(timer);
                    complete(value);
                });
            } catch (_) {
                global.clearTimeout(timer);
                complete(fallback);
            }
        });
    }

    function buildPayload(value, resolvedClientId) {
        var input = value || {};
        var payload = {
            source_lead_id: sourceId(input) || generatedAttemptId(input),
            created_at: text(input.createdAt) || new Date().toISOString(),
            name: text(input.name),
            phone: text(input.phone),
            email: text(input.email),
            message: text(input.message),
            page_url: text(input.pageUrl) || (global.location && global.location.href),
            referrer: text(input.referrer) || (document && document.referrer),
            client_id: text(input.clientId) || resolvedClientId,
            yclid: text(input.yclid) || queryValue('yclid'),
        };
        UTM_FIELDS.forEach(function (field) {
            payload[field] = text((input.utm || {})[field]) || text(input[field]) || queryValue(field);
        });
        Object.keys(payload).forEach(function (key) {
            if (payload[key] === undefined) {
                delete payload[key];
            }
        });
        return payload;
    }

    function init(value) {
        config = normalizeConfig(value);
        if (!config) {
            debug('Lead Collector configuration is invalid.');
            return false;
        }
        return true;
    }

    function send(value) {
        if (!config) {
            return Promise.resolve({ sent: false, reason: 'not_configured' });
        }
        return clientId().then(function (resolvedClientId) {
            var payload = buildPayload(value || {}, resolvedClientId);
            var url = config.endpoint + '/api/browser-leads/' + encodeURIComponent(config.projectId);
            var headers = {
                'Content-Type': 'application/json',
                'X-Lead-Collector-Public-Key': config.publicKey,
            };
            if (isNgrokFreeEndpoint(config.endpoint)) {
                headers['ngrok-skip-browser-warning'] = '1';
            }
            return global.fetch(url, {
                method: 'POST',
                mode: 'cors',
                keepalive: true,
                headers: headers,
                body: JSON.stringify(payload),
            }).then(function (response) {
                if (!response.ok) {
                    debug('Lead Collector delivery failed with HTTP status ' + response.status + '.');
                    return { sent: false, reason: 'http_error' };
                }
                return { sent: true, leadId: payload.source_lead_id };
            });
        }).catch(function (error) {
            debug('Lead Collector delivery failed:', error && error.name ? error.name : 'unknown_error');
            return { sent: false, reason: 'unavailable' };
        });
    }

    function registerAdapter(adapter) {
        if (typeof adapter !== 'function') {
            return false;
        }
        try {
            adapter({ send: send, config: function () { return config; } });
            return true;
        } catch (error) {
            debug('Lead Collector adapter failed:', error && error.name ? error.name : 'unknown_error');
            return false;
        }
    }

    global.LeadCollector = Object.freeze({
        version: '1.0.1',
        init: init,
        send: send,
        registerAdapter: registerAdapter,
    });

    var script = document && document.currentScript;
    if (script && script.dataset && script.dataset.projectId) {
        init({
            projectId: script.dataset.projectId,
            endpoint: script.dataset.endpoint,
            publicKey: script.dataset.publicKey,
            metrikaCounterId: script.dataset.metrikaCounterId,
            debug: script.dataset.debug === 'true',
        });
    }
})(window, document);
