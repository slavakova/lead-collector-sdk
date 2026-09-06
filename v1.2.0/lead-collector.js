/*
 * Lead Collector browser SDK.
 * AutoCapture records a lead only after a correlated, positive success signal.
 */
(function (global, document) {
    'use strict';

    var config = null;
    var attemptIds = new Map();
    var formAttempts = new WeakMap();
    var observedForms = new WeakSet();
    var recentAttempts = [];
    var autoInstalled = false;
    var fetchInstalled = false;
    var xhrInstalled = false;
    var domObserver = null;
    var jqueryBridgeInstalled = false;
    var jqueryBridgeRetries = 0;
    var jqueryBridgeRetryPending = false;
    var ATTEMPT_TTL_MS = 5 * 60 * 1000;
    var SIGNAL_WINDOW_MS = 30 * 1000;
    var REQUIRED_CONFIG = ['projectId', 'endpoint', 'publicKey'];
    var UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var FIELD_ALIASES = {
        name: ['name', 'fullname', 'full_name', 'full name', 'fio', 'your-name'],
        phone: ['phone', 'tel', 'telephone', 'phone_number', 'your-phone'],
        email: ['email', 'mail', 'your-email'],
        message: ['message', 'comment', 'question', 'textarea', 'your-message', 'task', 'description', 'details', 'problem'],
        address: ['address', 'addr', 'street', 'location', 'delivery_address', 'your-address'],
        company: ['company', 'organization', 'organisation', 'company_name'],
        service: ['service', 'service_type', 'work_type', 'category'],
    };
    var CONSENT_ALIASES = ['consent', 'agreement', 'privacy', 'personal_data', 'policy'];
    var SENSITIVE_FIELD = /(password|passcode|card|credit|debit|cvv|cvc|payment|passport|csrf|nonce|token|auth)/i;
    var DEFAULT_SUCCESS_SELECTORS = [
        '.wpcf7-mail-sent-ok', '.elementor-message-success', '.w-form-done',
        '.t-form__successbox', '.form-success', '[data-form-success]'
    ];

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

    function stringList(value) {
        return Array.isArray(value) ? value.filter(function (item) { return text(item); }).map(function (item) { return item.trim(); }) : [];
    }

    function normalizeRules(value) {
        var rules = value && typeof value === 'object' ? value : {};
        var aliases = rules.fieldAliases && typeof rules.fieldAliases === 'object' ? rules.fieldAliases : {};
        var extraAliases = rules.extraFieldAliases && typeof rules.extraFieldAliases === 'object' ? rules.extraFieldAliases : {};
        return {
            platformHint: text(rules.platformHint),
            successSelectors: stringList(rules.successSelectors),
            ignoreSelectors: stringList(rules.ignoreSelectors),
            formSelectors: stringList(rules.formSelectors),
            requestUrlPatterns: stringList(rules.requestUrlPatterns),
            fieldAliases: {
                name: stringList(aliases.name), phone: stringList(aliases.phone),
                email: stringList(aliases.email), message: stringList(aliases.message),
            },
            extraFieldAliases: {
                address: stringList(extraAliases.address), company: stringList(extraAliases.company),
                service: stringList(extraAliases.service), message: stringList(extraAliases.message),
            },
        };
    }

    function normalizeConfig(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        var normalized = {
            projectId: text(value.projectId), endpoint: text(value.endpoint), publicKey: text(value.publicKey),
            metrikaCounterId: value.metrikaCounterId || undefined, debug: value.debug === true,
            auto: value.auto === true, rules: normalizeRules(value.rules),
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
            return Array.prototype.map.call(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
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
            name: text(input.name), phone: text(input.phone), email: text(input.email), message: text(input.message),
            address: text(input.address), company: text(input.company), service: text(input.service),
            page_url: text(input.pageUrl) || (global.location && global.location.href),
            page_title: text(input.pageTitle) || text(document && document.title),
            referrer: text(input.referrer) || (document && document.referrer),
            client_id: text(input.clientId) || resolvedClientId, yclid: text(input.yclid) || queryValue('yclid'),
            consent: typeof input.consent === 'boolean' ? input.consent : undefined,
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
        if (config.auto) {
            installAutoCapture();
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
            var headers = { 'Content-Type': 'application/json', 'X-Lead-Collector-Public-Key': config.publicKey };
            if (isNgrokFreeEndpoint(config.endpoint)) {
                headers['ngrok-skip-browser-warning'] = '1';
            }
            return global.fetch(url, {
                method: 'POST', mode: 'cors', keepalive: true, headers: headers, body: JSON.stringify(payload),
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

    function elementText(element) {
        return text(element && (element.value || element.textContent || element.innerText || ''));
    }

    function labelsFor(element) {
        var labels = [];
        if (element && element.labels) {
            Array.prototype.forEach.call(element.labels, function (label) { labels.push(elementText(label)); });
        }
        return labels.join(' ');
    }

    function aliasesFor(kind) {
        var standard = FIELD_ALIASES[kind] || [];
        var rules = config && config.rules;
        var configured = rules && rules.fieldAliases[kind] ? rules.fieldAliases[kind] : [];
        var extra = rules && rules.extraFieldAliases[kind] ? rules.extraFieldAliases[kind] : [];
        return standard.concat(configured, extra);
    }

    function descriptorTokens(value) {
        return String(value || '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
    }

    function aliasMatches(tokens, alias) {
        var aliasTokens = descriptorTokens(alias);
        if (!aliasTokens.length || aliasTokens.length > tokens.length) { return false; }
        for (var index = 0; index <= tokens.length - aliasTokens.length; index += 1) {
            if (aliasTokens.every(function (token, offset) { return tokens[index + offset] === token; })) {
                return true;
            }
        }
        return false;
    }

    function kindFromTokens(tokens, kinds) {
        var best = null;
        kinds.forEach(function (kind) {
            aliasesFor(kind).forEach(function (alias) {
                var aliasTokens = descriptorTokens(alias);
                if (!aliasMatches(tokens, alias)) { return; }
                if (!best || aliasTokens.length > best.length) {
                    best = { kind: kind, length: aliasTokens.length };
                }
            });
        });
        return best ? best.kind : null;
    }

    function isConsentCheckbox(element, identity, presentation) {
        if ((text(element && element.type) || '').toLowerCase() !== 'checkbox') { return false; }
        var tokens = identity.concat(presentation);
        return CONSENT_ALIASES.some(function (alias) { return aliasMatches(tokens, alias); });
    }

    function fieldKind(element) {
        var type = (text(element && element.type) || '').toLowerCase();
        var tagName = String(element && element.tagName || '').toLowerCase();
        var autocomplete = (text(element && element.autocomplete) || '').toLowerCase();
        var identity = descriptorTokens([element && element.name, element && element.id].filter(Boolean).join(' '));
        var presentation = descriptorTokens([element && element.placeholder, labelsFor(element)].filter(Boolean).join(' '));
        var descriptor = identity.concat(descriptorTokens(type), descriptorTokens(autocomplete), presentation).join(' ');
        if (type === 'hidden' || SENSITIVE_FIELD.test(descriptor)) {
            return null;
        }
        if (type === 'password' || type === 'file') {
            return null;
        }
        if (type === 'tel') { return 'phone'; }
        if (type === 'email') { return 'email'; }
        if (tagName === 'textarea' || type === 'textarea') { return 'message'; }
        if (['tel', 'tel-national', 'tel-local'].indexOf(autocomplete) >= 0) { return 'phone'; }
        if (autocomplete === 'email') { return 'email'; }
        if (['name', 'given-name', 'family-name', 'additional-name'].indexOf(autocomplete) >= 0) { return 'name'; }
        return kindFromTokens(identity, ['phone', 'email', 'name', 'message', 'address', 'company', 'service']) ||
            kindFromTokens(presentation, ['phone', 'email', 'name', 'message', 'address', 'company', 'service']);
    }

    function extractFields(form) {
        var fields = {};
        if (!form || !form.elements) {
            return fields;
        }
        Array.prototype.forEach.call(form.elements, function (element) {
            if (!element || element.disabled) {
                return;
            }
            var identity = descriptorTokens([element.name, element.id].filter(Boolean).join(' '));
            var presentation = descriptorTokens([element.placeholder, labelsFor(element)].filter(Boolean).join(' '));
            if (isConsentCheckbox(element, identity, presentation)) {
                fields.consent = element.checked === true;
                return;
            }
            if (element.checked === false && /^(checkbox|radio)$/i.test(element.type || '')) {
                return;
            }
            var kind = fieldKind(element);
            var value = elementText(element);
            if (kind && value && !fields[kind]) {
                fields[kind] = value;
            }
        });
        return fields;
    }

    function selectorMatches(element, selector) {
        try {
            return !!element && typeof element.matches === 'function' && element.matches(selector);
        } catch (_) {
            return false;
        }
    }

    function closest(element, selector) {
        try {
            return element && typeof element.closest === 'function' ? element.closest(selector) : null;
        } catch (_) {
            return null;
        }
    }

    function matchesAny(element, selectors) {
        return selectors.some(function (selector) { return selectorMatches(element, selector) || !!closest(element, selector); });
    }

    function isEligibleForm(form) {
        if (!form || String(form.tagName || '').toLowerCase() !== 'form') {
            return false;
        }
        var rules = config && config.rules;
        if (rules && rules.ignoreSelectors.length && matchesAny(form, rules.ignoreSelectors)) {
            return false;
        }
        return !rules || !rules.formSelectors.length || matchesAny(form, rules.formSelectors);
    }

    function formAction(form) {
        var action = text(form && form.action) || (global.location && global.location.href) || '';
        try { return new URL(action, global.location && global.location.href).toString(); } catch (_) { return action; }
    }

    function formMethod(form) {
        return (text(form && form.method) || 'get').toUpperCase();
    }

    function pruneAttempts(now) {
        recentAttempts = recentAttempts.filter(function (attempt) { return now - attempt.createdAt < ATTEMPT_TTL_MS; });
    }

    function createAttempt(form, submitter) {
        var now = Date.now();
        pruneAttempts(now);
        var fields = extractFields(form);
        var attempt = {
            id: randomId(), form: form, createdAt: now, createdAtIso: new Date().toISOString(), fields: fields,
            pageUrl: global.location && global.location.href, referrer: document && document.referrer,
            action: formAction(form), method: formMethod(form), submitter: submitter || null,
            completed: false, deliveryPromise: null,
        };
        formAttempts.set(form, attempt);
        recentAttempts.push(attempt);
        return attempt;
    }

    function currentAttempt(form, createIfMissing) {
        var existing = form && formAttempts.get(form);
        if (existing && Date.now() - existing.createdAt < ATTEMPT_TTL_MS) {
            return existing;
        }
        return createIfMissing ? createAttempt(form) : null;
    }

    function isValidForm(form) {
        try { return !form || typeof form.checkValidity !== 'function' || form.checkValidity(); } catch (_) { return false; }
    }

    function onSubmit(event) {
        var form = event && (event.currentTarget || event.target);
        if (!isEligibleForm(form) || !isValidForm(form)) {
            return;
        }
        createAttempt(form, event.submitter || null);
    }

    function observeForm(form) {
        if (!isEligibleForm(form) || observedForms.has(form)) {
            return;
        }
        observedForms.add(form);
        if (typeof form.addEventListener === 'function') {
            form.addEventListener('submit', onSubmit, true);
        }
    }

    function discoverForms(root) {
        if (!root) { return; }
        if (String(root.tagName || '').toLowerCase() === 'form') { observeForm(root); }
        if (typeof root.querySelectorAll === 'function') {
            try { Array.prototype.forEach.call(root.querySelectorAll('form'), observeForm); } catch (_) { /* host DOM is left untouched */ }
        }
    }

    function completedAttempt(attempt, source) {
        if (!attempt || attempt.completed || Date.now() - attempt.createdAt > ATTEMPT_TTL_MS) {
            return Promise.resolve({ sent: false, reason: 'already_completed' });
        }
        if (attempt.deliveryPromise) {
            return attempt.deliveryPromise;
        }
        attempt.deliveryPromise = send({
            sourceLeadId: attempt.id, createdAt: attempt.createdAtIso, name: attempt.fields.name,
            phone: attempt.fields.phone, email: attempt.fields.email, message: attempt.fields.message,
            address: attempt.fields.address, company: attempt.fields.company, service: attempt.fields.service,
            consent: attempt.fields.consent,
            pageUrl: attempt.pageUrl, referrer: attempt.referrer,
        }).then(function (result) {
            attempt.deliveryPromise = null;
            if (result && result.sent === true) {
                attempt.completed = true;
            }
            debug('Lead Collector success signal:', source, result.sent ? 'sent' : result.reason);
            return result;
        }, function () {
            attempt.deliveryPromise = null;
            return { sent: false, reason: 'unavailable' };
        });
        return attempt.deliveryPromise;
    }

    function success(formOrPayload) {
        if (formOrPayload && typeof formOrPayload === 'object' && String(formOrPayload.tagName || '').toLowerCase() === 'form') {
            var existing = currentAttempt(formOrPayload, false);
            if (existing) {
                return completedAttempt(existing, 'explicit');
            }
            if (!isEligibleForm(formOrPayload) || !isValidForm(formOrPayload)) {
                return Promise.resolve({ sent: false, reason: 'ignored_form' });
            }
            return completedAttempt(createAttempt(formOrPayload), 'explicit');
        }
        return send(formOrPayload || {});
    }

    function requestMatchesRules(url) {
        var patterns = config && config.rules ? config.rules.requestUrlPatterns : [];
        return !patterns.length || patterns.some(function (pattern) { return url.indexOf(pattern) >= 0; });
    }

    function sameUrl(left, right) {
        try {
            var leftUrl = new URL(left, global.location && global.location.href);
            var rightUrl = new URL(right, global.location && global.location.href);
            return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
        } catch (_) { return left === right; }
    }

    function bodyContainsAttempt(body, attempt) {
        if (!body || !attempt || !attempt.fields) { return false; }
        var values = [attempt.fields.phone, attempt.fields.email].filter(Boolean);
        if (!values.length) { return false; }
        try {
            if (typeof body === 'string') {
                var decoded = body;
                try { decoded = decodeURIComponent(body.replace(/\+/g, '%20')); } catch (_) { /* raw body remains available */ }
                return values.some(function (value) { return body.indexOf(value) >= 0 || decoded.indexOf(value) >= 0; });
            }
            if (typeof body.get === 'function') {
                return values.some(function (value) {
                    return Array.prototype.some.call(attempt.form.elements || [], function (field) {
                        return field && field.name && body.get(field.name) === value;
                    });
                });
            }
        } catch (_) { return false; }
        return false;
    }

    function correlatedAttempt(request) {
        var now = Date.now();
        if (!requestMatchesRules(request.url)) { return null; }
        var candidates = recentAttempts.filter(function (attempt) {
            return !attempt.completed && now - attempt.createdAt <= SIGNAL_WINDOW_MS;
        }).map(function (attempt) {
            var actionMatch = sameUrl(attempt.action, request.url);
            var bodyMatch = bodyContainsAttempt(request.body, attempt);
            var patternMatch = config && config.rules && config.rules.requestUrlPatterns.length > 0;
            if (!actionMatch && !bodyMatch && !patternMatch) { return null; }
            var score = (bodyMatch ? 8 : 0) + (actionMatch ? 6 : 0) + (patternMatch ? 3 : 0) +
                (attempt.method === request.method ? 1 : 0);
            return { attempt: attempt, score: score };
        }).filter(Boolean).sort(function (left, right) { return right.score - left.score; });
        if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score)) { return null; }
        return candidates[0].attempt;
    }

    function responseIsSuccess(response) {
        if (!response || !response.ok || typeof response.clone !== 'function') {
            return Promise.resolve(false);
        }
        try {
            return response.clone().json().then(function (body) {
                if (!body || typeof body !== 'object') { return false; }
                var status = text(body.status);
                var nested = body.data && typeof body.data === 'object' ? body.data : {};
                return body.success === true || nested.success === true || (status && status.toLowerCase() === 'success');
            }).catch(function () { return false; });
        } catch (_) { return Promise.resolve(false); }
    }

    function fetchRequestInfo(input, init) {
        var request = input && typeof input === 'object' ? input : {};
        return {
            url: typeof input === 'string' ? input : (request.url || String(input || '')),
            method: String((init && init.method) || request.method || 'GET').toUpperCase(),
            body: init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : null,
        };
    }

    function installFetchProvider() {
        if (fetchInstalled || typeof global.fetch !== 'function') { return; }
        var originalFetch = global.fetch;
        fetchInstalled = true;
        global.fetch = function () {
            var request = fetchRequestInfo(arguments[0], arguments[1]);
            var result = originalFetch.apply(this, arguments);
            Promise.resolve(result).then(function (response) {
                var attempt = correlatedAttempt(request);
                if (!attempt) { return; }
                responseIsSuccess(response).then(function (positive) {
                    if (positive) { completedAttempt(attempt, 'fetch'); }
                }).catch(function () { /* instrumentation never affects the host */ });
            }).catch(function () { /* original rejection remains untouched */ });
            return result;
        };
    }

    function xhrIsSuccess(xhr) {
        if (!xhr || xhr.status < 200 || xhr.status >= 300) { return false; }
        try {
            var body = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText || '');
            var status = text(body && body.status);
            var nested = body && body.data && typeof body.data === 'object' ? body.data : {};
            return !!body && (body.success === true || nested.success === true || (status && status.toLowerCase() === 'success'));
        } catch (_) { return false; }
    }

    function installXhrProvider() {
        if (xhrInstalled || !global.XMLHttpRequest || !global.XMLHttpRequest.prototype) { return; }
        var prototype = global.XMLHttpRequest.prototype;
        if (typeof prototype.open !== 'function' || typeof prototype.send !== 'function') { return; }
        var metadata = new WeakMap();
        var originalOpen = prototype.open;
        var originalSend = prototype.send;
        xhrInstalled = true;
        prototype.open = function (method, url) {
            metadata.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url || ''), body: null });
            return originalOpen.apply(this, arguments);
        };
        prototype.send = function (body) {
            var xhr = this;
            var record = metadata.get(xhr);
            if (record) {
                record.body = body;
                if (typeof xhr.addEventListener === 'function') {
                    xhr.addEventListener('loadend', function () {
                        try {
                            var attempt = correlatedAttempt({ url: record.url, method: record.method, body: record.body });
                            if (attempt && xhrIsSuccess(xhr)) { completedAttempt(attempt, 'xhr'); }
                        } catch (_) { /* instrumentation never affects the host */ }
                    });
                }
            }
            return originalSend.apply(xhr, arguments);
        };
    }

    function attemptForSuccessElement(element) {
        var form = closest(element, 'form');
        if (form) { return currentAttempt(form, false); }
        var now = Date.now();
        var candidates = recentAttempts.filter(function (attempt) {
            return !attempt.completed && now - attempt.createdAt <= SIGNAL_WINDOW_MS;
        });
        var nearby = candidates.filter(function (attempt) {
            return attempt.form && attempt.form.parentNode && attempt.form.parentNode === element.parentNode;
        });
        if (nearby.length === 1) { return nearby[0]; }
        return nearby.length === 0 && candidates.length === 1 ? candidates[0] : null;
    }

    function domSuccessSignal(element) {
        if (!element || !config) { return; }
        var selectors = DEFAULT_SUCCESS_SELECTORS.concat(config.rules.successSelectors);
        if (!matchesAny(element, selectors)) { return; }
        var attempt = attemptForSuccessElement(element);
        if (attempt && Date.now() - attempt.createdAt <= SIGNAL_WINDOW_MS) {
            completedAttempt(attempt, 'dom');
        }
    }

    function installDomProvider() {
        if (!global.MutationObserver || domObserver || !document) { return; }
        try {
            domObserver = new global.MutationObserver(function (mutations) {
                mutations.forEach(function (mutation) {
                    if (mutation.type === 'childList') {
                        Array.prototype.forEach.call(mutation.addedNodes || [], function (node) {
                            discoverForms(node);
                            domSuccessSignal(node);
                            if (node && typeof node.querySelectorAll === 'function') {
                                DEFAULT_SUCCESS_SELECTORS.concat(config.rules.successSelectors).forEach(function (selector) {
                                    try { Array.prototype.forEach.call(node.querySelectorAll(selector), domSuccessSignal); } catch (_) { /* invalid host selector */ }
                                });
                            }
                        });
                    } else if (mutation.type === 'attributes') {
                        domSuccessSignal(mutation.target);
                    }
                });
            });
            domObserver.observe(document.documentElement || document.body, {
                childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
            });
        } catch (_) { domObserver = null; }
    }

    function formFromEvent(event, possibleForm) {
        var target = possibleForm || (event && event.target);
        if (target && String(target.tagName || '').toLowerCase() === 'form') { return target; }
        return closest(target, 'form');
    }

    function installPlatformProviders() {
        if (!document || typeof document.addEventListener !== 'function') { return; }
        ['wpcf7mailsent', 'tildaform:aftersuccess', 'elementor:form:success', 'elementor:form:submit_success'].forEach(function (eventName) {
            document.addEventListener(eventName, function (event) {
                var form = formFromEvent(event);
                if (form) { completedAttempt(currentAttempt(form, false), 'platform'); }
            });
        });
        installJQueryElementorBridge();
        scheduleJQueryElementorBridge();
    }

    function installJQueryElementorBridge() {
        if (jqueryBridgeInstalled || !global.jQuery || typeof global.jQuery !== 'function') { return false; }
        try {
            global.jQuery(document).on('submit_success', function (event, _response, form) {
                var element = form && form[0] ? form[0] : form;
                var resolved = formFromEvent(event, element);
                if (resolved) { completedAttempt(currentAttempt(resolved, false), 'platform'); }
            });
            jqueryBridgeInstalled = true;
            return true;
        } catch (_) { return false; }
    }

    function scheduleJQueryElementorBridge() {
        if (jqueryBridgeInstalled || jqueryBridgeRetryPending || jqueryBridgeRetries >= 10 || typeof global.setTimeout !== 'function') {
            return;
        }
        jqueryBridgeRetryPending = true;
        var timer = global.setTimeout(function () {
            jqueryBridgeRetryPending = false;
            jqueryBridgeRetries += 1;
            if (!installJQueryElementorBridge()) { scheduleJQueryElementorBridge(); }
        }, 500);
        if (timer && typeof timer.unref === 'function') { timer.unref(); }
    }

    function installAutoCapture() {
        if (autoInstalled || !document) { return; }
        autoInstalled = true;
        discoverForms(document);
        if (typeof document.addEventListener === 'function') {
            document.addEventListener('DOMContentLoaded', function () {
                discoverForms(document);
                if (!installJQueryElementorBridge()) { scheduleJQueryElementorBridge(); }
            });
        }
        installPlatformProviders();
        installFetchProvider();
        installXhrProvider();
        installDomProvider();
    }

    function registerAdapter(adapter) {
        if (typeof adapter !== 'function') { return false; }
        try {
            adapter({ send: send, success: success, config: function () { return config; } });
            return true;
        } catch (error) {
            debug('Lead Collector adapter failed:', error && error.name ? error.name : 'unknown_error');
            return false;
        }
    }

    global.LeadCollector = Object.freeze({
        version: '1.2.0', init: init, send: send, success: success, registerAdapter: registerAdapter,
    });

    var script = document && document.currentScript;
    if (script && script.dataset && script.dataset.projectId) {
        init({
            projectId: script.dataset.projectId, endpoint: script.dataset.endpoint, publicKey: script.dataset.publicKey,
            metrikaCounterId: script.dataset.metrikaCounterId, debug: script.dataset.debug === 'true',
            auto: script.dataset.auto === 'true',
        });
    }
})(window, document);
