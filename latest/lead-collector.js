/*
 * Lead Collector browser SDK.
 * AutoCapture records a lead only after a correlated, positive success signal.
 */
(function (global, document) {
    'use strict';

    var config = null;
    var attemptIds = new Map();
    var formAttempts = new WeakMap();
    var submitEventAttempts = new WeakMap();
    var observedForms = new WeakSet();
    var recentAttempts = [];
    var autoInstalled = false;
    var submitCaptureInstalled = false;
    var fetchInstalled = false;
    var xhrInstalled = false;
    var domObserver = null;
    var jqueryBridgeInstalled = false;
    var jqueryBridgeRetries = 0;
    var jqueryBridgeRetryPending = false;
    var metrikaClientIdCache = null;
    // One source_lead_id is allowed to have only one active Browser API delivery.
    // The map is shared by AJAX and navigation recovery paths.
    var activeDeliveryPromises = new Map();
    var ATTEMPT_TTL_MS = 5 * 60 * 1000;
    var SIGNAL_WINDOW_MS = 30 * 1000;
    var NAVIGATION_STORAGE_LIMIT = 5;
    var NAVIGATION_STORAGE_PREFIX = 'lead-collector:navigation-attempts:v1:';
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
    var POSITIVE_URL_MARKERS = ['success', 'sent', 'submitted', 'thank-you', 'thankyou'];
    var FAILURE_URL_MARKERS = ['error', 'failed', 'failure', 'invalid', 'rejected'];
    var SUCCESS_QUERY_KEYS = ['lead', 'status', 'result', 'submission', 'form'];

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

    function navigationStorageKey() {
        if (!config) { return null; }
        return NAVIGATION_STORAGE_PREFIX + encodeURIComponent(config.projectId);
    }

    function navigationStorage() {
        try {
            return global && global.sessionStorage && typeof global.sessionStorage.getItem === 'function' &&
                typeof global.sessionStorage.setItem === 'function' ? global.sessionStorage : null;
        } catch (_) {
            return null;
        }
    }

    function safeNavigationSnapshot(value) {
        if (!value || typeof value !== 'object') { return null; }
        var createdAt = Number(value.createdAt);
        var sourceLeadId = text(value.sourceLeadId) || text(value.source_lead_id) || text(value.id);
        if (!sourceLeadId || !isFinite(createdAt) || createdAt <= 0) { return null; }
        var fields = value.fields && typeof value.fields === 'object' ? value.fields : value;
        var snapshot = {
            sourceLeadId: sourceLeadId,
            createdAt: createdAt,
            createdAtIso: text(value.createdAtIso),
            name: text(fields.name), phone: text(fields.phone), email: text(fields.email), message: text(fields.message),
            address: text(fields.address), company: text(fields.company), service: text(fields.service),
            pageUrl: text(value.pageUrl), pageTitle: text(value.pageTitle), referrer: text(value.referrer),
            clientId: text(value.clientId),
            clientIdSource: value.clientIdSource === 'metrika' || value.clientIdSource === 'cookie' ? value.clientIdSource : undefined,
            clientIdCapturedAt: isFinite(Number(value.clientIdCapturedAt)) ? Number(value.clientIdCapturedAt) : undefined,
            yclid: text(value.yclid),
            consent: typeof fields.consent === 'boolean' ? fields.consent : undefined,
            utm: {},
        };
        var rawUtm = value.utm && typeof value.utm === 'object' ? value.utm : {};
        UTM_FIELDS.forEach(function (field) {
            var item = text(rawUtm[field]);
            if (item) { snapshot.utm[field] = item; }
        });
        Object.keys(snapshot).forEach(function (key) {
            if (snapshot[key] === undefined) { delete snapshot[key]; }
        });
        return snapshot;
    }

    function emptyNavigationRegistry() {
        return { pending: [], delivering: [], delivered: [] };
    }

    function pruneNavigationRegistry(value, now) {
        var registry = value && typeof value === 'object' ? value : emptyNavigationRegistry();
        var pending = Array.isArray(registry.pending) ? registry.pending.map(safeNavigationSnapshot).filter(function (item) {
            return item && now - item.createdAt >= 0 && now - item.createdAt < ATTEMPT_TTL_MS;
        }) : [];
        var delivering = Array.isArray(registry.delivering) ? registry.delivering.map(safeNavigationSnapshot).filter(function (item) {
            return item && now - item.createdAt >= 0 && now - item.createdAt < ATTEMPT_TTL_MS;
        }) : [];
        var delivered = Array.isArray(registry.delivered) ? registry.delivered.filter(function (item) {
            return item && typeof item === 'object' && text(item.sourceLeadId) && isFinite(Number(item.deliveredAt)) &&
                now - Number(item.deliveredAt) >= 0 && now - Number(item.deliveredAt) < ATTEMPT_TTL_MS;
        }).map(function (item) {
            return { sourceLeadId: text(item.sourceLeadId), deliveredAt: Number(item.deliveredAt) };
        }) : [];
        return {
            pending: pending.slice(-NAVIGATION_STORAGE_LIMIT),
            delivering: delivering.slice(-NAVIGATION_STORAGE_LIMIT),
            delivered: delivered.slice(-NAVIGATION_STORAGE_LIMIT),
        };
    }

    function readNavigationRegistry() {
        var storage = navigationStorage();
        var key = navigationStorageKey();
        if (!storage || !key) { return null; }
        try {
            var raw = storage.getItem(key);
            var parsed = raw ? JSON.parse(raw) : emptyNavigationRegistry();
            return pruneNavigationRegistry(parsed, Date.now());
        } catch (_) {
            return emptyNavigationRegistry();
        }
    }

    function writeNavigationRegistry(registry) {
        var storage = navigationStorage();
        var key = navigationStorageKey();
        if (!storage || !key || !registry) { return; }
        try {
            storage.setItem(key, JSON.stringify(pruneNavigationRegistry(registry, Date.now())));
        } catch (_) { /* storage is an optional resilience aid */ }
    }

    function persistNavigationAttempt(attempt) {
        var registry = readNavigationRegistry();
        if (!registry || !attempt) { return; }
        var snapshot = safeNavigationSnapshot({
            sourceLeadId: attempt.id, createdAt: attempt.createdAt, createdAtIso: attempt.createdAtIso,
            fields: attempt.fields, pageUrl: attempt.pageUrl, pageTitle: attempt.pageTitle, referrer: attempt.referrer,
            clientId: attempt.clientId, clientIdSource: attempt.clientIdSource, clientIdCapturedAt: attempt.clientIdCapturedAt,
            yclid: attempt.yclid, utm: attempt.utm,
        });
        if (!snapshot) { return; }
        registry.pending = registry.pending.filter(function (item) { return item.sourceLeadId !== snapshot.sourceLeadId; });
        registry.delivering = registry.delivering.filter(function (item) { return item.sourceLeadId !== snapshot.sourceLeadId; });
        registry.delivered = registry.delivered.filter(function (item) { return item.sourceLeadId !== snapshot.sourceLeadId; });
        registry.pending.push(snapshot);
        writeNavigationRegistry(registry);
    }

    function beginNavigationDelivery(sourceLeadId) {
        var registry = readNavigationRegistry();
        if (!sourceLeadId) { return false; }
        // sessionStorage is optional; inability to persist recovery state must never
        // prevent the normal AJAX delivery path.
        if (!registry) { return true; }
        var snapshot = registry.pending.filter(function (item) { return item.sourceLeadId === sourceLeadId; })[0];
        if (registry.delivering.some(function (item) { return item.sourceLeadId === sourceLeadId; })) {
            return false;
        }
        if (!snapshot) { return true; }
        registry.pending = registry.pending.filter(function (item) { return item.sourceLeadId !== sourceLeadId; });
        registry.delivering = registry.delivering.filter(function (item) { return item.sourceLeadId !== sourceLeadId; });
        registry.delivering.push(snapshot);
        writeNavigationRegistry(registry);
        return true;
    }

    function settleNavigationDelivery(sourceLeadId, delivered) {
        var registry = readNavigationRegistry();
        if (!registry || !sourceLeadId) { return; }
        var snapshot = registry.delivering.filter(function (item) { return item.sourceLeadId === sourceLeadId; })[0] ||
            registry.pending.filter(function (item) { return item.sourceLeadId === sourceLeadId; })[0];
        registry.pending = registry.pending.filter(function (item) { return item.sourceLeadId !== sourceLeadId; });
        registry.delivering = registry.delivering.filter(function (item) { return item.sourceLeadId !== sourceLeadId; });
        if (delivered) {
            registry.delivered = registry.delivered.filter(function (item) { return item.sourceLeadId !== sourceLeadId; });
            registry.delivered.push({ sourceLeadId: sourceLeadId, deliveredAt: Date.now() });
        } else if (snapshot) {
            registry.pending.push(snapshot);
        }
        writeNavigationRegistry(registry);
    }

    function cachedMetrikaClientId() {
        return text(metrikaClientIdCache);
    }

    function knownClientId() {
        return cachedMetrikaClientId() || cookie('_ym_uid');
    }

    function knownClientIdSource() {
        return cachedMetrikaClientId() ? 'metrika' : (cookie('_ym_uid') ? 'cookie' : undefined);
    }

    function clientId(snapshotClientId) {
        // With a configured counter, its API is canonical. A current browser
        // cookie is only a fallback, and a persisted navigation value is last.
        var fallback = config && config.metrikaCounterId ?
            (cookie('_ym_uid') || text(snapshotClientId) || cachedMetrikaClientId()) :
            (text(snapshotClientId) || cookie('_ym_uid') || cachedMetrikaClientId());
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
                    var current = text(value);
                    if (current) { metrikaClientIdCache = current; }
                    complete(current);
                });
            } catch (_) {
                global.clearTimeout(timer);
                complete(fallback);
            }
        });
    }

    function primeMetrikaClientId() {
        if (config && config.metrikaCounterId && typeof global.ym === 'function') {
            clientId();
        }
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
            client_id: text(resolvedClientId) || text(input.clientId), yclid: text(input.yclid) || queryValue('yclid'),
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
        var previousCounterId = config && config.metrikaCounterId;
        config = normalizeConfig(value);
        if (!config) {
            debug('Lead Collector configuration is invalid.');
            return false;
        }
        if (previousCounterId !== config.metrikaCounterId) {
            metrikaClientIdCache = null;
        }
        primeMetrikaClientId();
        if (config.auto) {
            installAutoCapture();
        }
        return true;
    }

    function send(value) {
        if (!config) {
            return Promise.resolve({ sent: false, reason: 'not_configured' });
        }
        return clientId(value && value.clientId).then(function (resolvedClientId) {
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
            pageUrl: global.location && global.location.href, pageTitle: document && document.title,
            referrer: document && document.referrer, clientId: knownClientId(), clientIdSource: knownClientIdSource(),
            clientIdCapturedAt: now, yclid: queryValue('yclid'), utm: {},
            action: formAction(form), method: formMethod(form), submitter: submitter || null,
            completed: false, deliveryState: 'pending', deliveryPromise: null,
        };
        UTM_FIELDS.forEach(function (field) { attempt.utm[field] = queryValue(field); });
        formAttempts.set(form, attempt);
        recentAttempts.push(attempt);
        persistNavigationAttempt(attempt);
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

    function ensureSubmitAttempt(form, submitter, event) {
        if (!isEligibleForm(form) || !isValidForm(form)) {
            return null;
        }
        if (event && typeof event === 'object') {
            var eventAttempt = submitEventAttempts.get(event);
            if (eventAttempt && eventAttempt.form === form) {
                return eventAttempt;
            }
        }
        var attempt = createAttempt(form, submitter);
        if (event && typeof event === 'object') {
            submitEventAttempts.set(event, attempt);
        }
        return attempt;
    }

    function onSubmit(event) {
        var form = event && (event.currentTarget || event.target);
        ensureSubmitAttempt(form, event && event.submitter || null, event);
    }

    function onWindowSubmit(event) {
        ensureSubmitAttempt(event && event.target, event && event.submitter || null, event);
    }

    function installSubmitCapture() {
        if (submitCaptureInstalled || !global || typeof global.addEventListener !== 'function') {
            return;
        }
        global.addEventListener('submit', onWindowSubmit, true);
        submitCaptureInstalled = true;
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
        if (!attempt || attempt.completed || attempt.deliveryState === 'delivered' || Date.now() - attempt.createdAt > ATTEMPT_TTL_MS) {
            return Promise.resolve({ sent: false, reason: 'already_completed' });
        }
        if (attempt.deliveryState === 'delivering' && attempt.deliveryPromise) {
            return attempt.deliveryPromise;
        }
        var active = activeDeliveryPromises.get(attempt.id);
        if (active) {
            attempt.deliveryState = 'delivering';
            attempt.deliveryPromise = active;
            return active;
        }
        if (!beginNavigationDelivery(attempt.id)) {
            return Promise.resolve({ sent: false, reason: 'delivery_in_progress' });
        }
        attempt.deliveryState = 'delivering';
        var delivery = send({
            sourceLeadId: attempt.id, createdAt: attempt.createdAtIso, name: attempt.fields.name,
            phone: attempt.fields.phone, email: attempt.fields.email, message: attempt.fields.message,
            address: attempt.fields.address, company: attempt.fields.company, service: attempt.fields.service,
            consent: attempt.fields.consent,
            pageUrl: attempt.pageUrl, pageTitle: attempt.pageTitle, referrer: attempt.referrer,
            clientId: attempt.clientId, yclid: attempt.yclid, utm: attempt.utm,
        }).then(function (result) {
            attempt.deliveryPromise = null;
            if (result && result.sent === true) {
                attempt.completed = true;
                attempt.deliveryState = 'delivered';
                settleNavigationDelivery(attempt.id, true);
            } else {
                attempt.deliveryState = 'pending';
                settleNavigationDelivery(attempt.id, false);
            }
            debug('Lead Collector success signal:', source, result.sent ? 'sent' : result.reason);
            return result;
        }, function () {
            attempt.deliveryPromise = null;
            attempt.deliveryState = 'pending';
            settleNavigationDelivery(attempt.id, false);
            return { sent: false, reason: 'unavailable' };
        }).then(function (result) {
            activeDeliveryPromises.delete(attempt.id);
            return result;
        });
        attempt.deliveryPromise = delivery;
        activeDeliveryPromises.set(attempt.id, delivery);
        return delivery;
    }

    function markerInText(value, markers) {
        var normalized = String(value || '').toLowerCase();
        return markers.some(function (marker) {
            return normalized.split(/[^a-z0-9-]+/).some(function (token) { return token === marker; });
        });
    }

    function navigationUrlSignals() {
        try {
            var url = new URL(global.location && global.location.href);
            var positive = markerInText(url.pathname, POSITIVE_URL_MARKERS) || markerInText(url.hash, POSITIVE_URL_MARKERS);
            var failure = markerInText(url.pathname, FAILURE_URL_MARKERS) || markerInText(url.hash, FAILURE_URL_MARKERS);
            url.searchParams.forEach(function (rawValue, rawKey) {
                var key = String(rawKey || '').toLowerCase();
                var value = String(rawValue || '').toLowerCase();
                if (SUCCESS_QUERY_KEYS.indexOf(key) >= 0 && POSITIVE_URL_MARKERS.indexOf(value) >= 0) {
                    positive = true;
                }
                if (key === 'success' && (value === '' || value === '1' || value === 'true' || value === 'yes')) {
                    positive = true;
                }
                if (['error', 'failed', 'failure', 'invalid', 'rejected'].indexOf(key) >= 0 ||
                    (SUCCESS_QUERY_KEYS.indexOf(key) >= 0 && FAILURE_URL_MARKERS.indexOf(value) >= 0)) {
                    failure = true;
                }
            });
            return { positive: positive, failure: failure };
        } catch (_) {
            return { positive: false, failure: false };
        }
    }

    function hasDocumentSuccessSignal() {
        if (!document || !config) { return false; }
        var selectors = DEFAULT_SUCCESS_SELECTORS.concat(config.rules.successSelectors);
        if (matchesAny(document, selectors)) { return true; }
        if (typeof document.querySelectorAll !== 'function') { return false; }
        return selectors.some(function (selector) {
            try { return document.querySelectorAll(selector).length > 0; } catch (_) { return false; }
        });
    }

    function recoverNavigationAttempts() {
        if (!config) { return; }
        var signals = navigationUrlSignals();
        if (signals.failure || (!signals.positive && !hasDocumentSuccessSignal())) { return; }
        var registry = readNavigationRegistry();
        if (!registry) { return; }
        writeNavigationRegistry(registry);
        var candidates = registry.pending.filter(function (snapshot) {
            return !registry.delivered.some(function (item) { return item.sourceLeadId === snapshot.sourceLeadId; });
        }).sort(function (left, right) {
            return right.createdAt - left.createdAt;
        }).slice(0, 1);
        candidates.forEach(function (snapshot) {
            if (activeDeliveryPromises.has(snapshot.sourceLeadId) || !beginNavigationDelivery(snapshot.sourceLeadId)) { return; }
            var delivery = send(snapshot).then(function (result) {
                if (result && result.sent === true) {
                    settleNavigationDelivery(snapshot.sourceLeadId, true);
                } else {
                    settleNavigationDelivery(snapshot.sourceLeadId, false);
                }
                debug('Lead Collector navigation success signal:', result && result.sent ? 'sent' : result && result.reason);
                return result;
            }, function () {
                settleNavigationDelivery(snapshot.sourceLeadId, false);
                return { sent: false, reason: 'unavailable' };
            }).then(function (result) {
                activeDeliveryPromises.delete(snapshot.sourceLeadId);
                return result;
            });
            activeDeliveryPromises.set(snapshot.sourceLeadId, delivery);
        });
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

    function isWordPressAdminAjaxRequest(request) {
        if (!request || request.method !== 'POST') { return false; }
        try {
            var requestUrl = new URL(request.url, global.location && global.location.href);
            var pageUrl = new URL(global.location && global.location.href);
            return requestUrl.origin === pageUrl.origin && requestUrl.pathname === '/wp-admin/admin-ajax.php';
        } catch (_) { return false; }
    }

    function requestBodyEntries(body) {
        var entries = [];
        try {
            if (typeof body === 'string') {
                new URLSearchParams(body).forEach(function (value, key) { entries.push([key, value]); });
            } else if (body && typeof body.forEach === 'function') {
                body.forEach(function (value, key) { entries.push([key, value]); });
            }
        } catch (_) { return []; }
        return entries;
    }

    function wordpressAdminAjaxBodyMatchesAttempt(body, attempt) {
        var entries = requestBodyEntries(body);
        var actionPresent = entries.some(function (entry) {
            return entry[0] === 'action' && text(entry[1]);
        });
        if (!actionPresent || !attempt || !attempt.fields) { return false; }
        return entries.some(function (entry) {
            var kind = kindFromTokens(descriptorTokens(entry[0]), ['phone', 'email', 'name', 'message', 'service']);
            var value = text(entry[1]);
            return kind && value && value === text(attempt.fields[kind]);
        });
    }

    function correlatedAttempt(request) {
        var now = Date.now();
        if (!requestMatchesRules(request.url)) { return null; }
        var wordpressAdminAjax = isWordPressAdminAjaxRequest(request);
        var candidates = recentAttempts.filter(function (attempt) {
            return !attempt.completed && now - attempt.createdAt <= SIGNAL_WINDOW_MS;
        }).map(function (attempt) {
            var actionMatch = sameUrl(attempt.action, request.url);
            var bodyMatch = bodyContainsAttempt(request.body, attempt);
            var patternMatch = config && config.rules && config.rules.requestUrlPatterns.length > 0;
            if (wordpressAdminAjax) {
                var wordpressBodyMatch = wordpressAdminAjaxBodyMatchesAttempt(request.body, attempt);
                if (!wordpressBodyMatch) { return null; }
                return { attempt: attempt, score: 12 + (attempt.method === request.method ? 1 : 0) };
            }
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

    function wordpressAdminAjaxResponseIsSuccess(response) {
        if (!response || !response.ok || typeof response.clone !== 'function') {
            return Promise.resolve(false);
        }
        try {
            return response.clone().json().then(function (body) {
                return !!body && typeof body === 'object' && body.success === true;
            }).catch(function () { return false; });
        } catch (_) { return Promise.resolve(false); }
    }

    function requestResponseIsSuccess(request, response) {
        return isWordPressAdminAjaxRequest(request) ?
            wordpressAdminAjaxResponseIsSuccess(response) : responseIsSuccess(response);
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
                requestResponseIsSuccess(request, response).then(function (positive) {
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

    function xhrRequestIsSuccess(request, xhr) {
        if (!isWordPressAdminAjaxRequest(request)) { return xhrIsSuccess(xhr); }
        if (!xhr || xhr.status < 200 || xhr.status >= 300) { return false; }
        try {
            var body = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText || '');
            return !!body && typeof body === 'object' && body.success === true;
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
                            var request = { url: record.url, method: record.method, body: record.body };
                            var attempt = correlatedAttempt(request);
                            if (attempt && xhrRequestIsSuccess(request, xhr)) { completedAttempt(attempt, 'xhr'); }
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
                        recoverNavigationAttempts();
                    } else if (mutation.type === 'attributes') {
                        domSuccessSignal(mutation.target);
                        recoverNavigationAttempts();
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

    function completedTildaAttempt(event) {
        var form = formFromEvent(event);
        if (!form) { return; }
        var attempt = currentAttempt(form, false);
        if (!attempt) {
            // Tilda can confirm a form without dispatching a native submit event.
            // Its aftersuccess event is the authoritative signal for a new attempt.
            if (!isEligibleForm(form) || !isValidForm(form)) { return; }
            attempt = createAttempt(form);
        }
        completedAttempt(attempt, 'tilda');
    }

    function installPlatformProviders() {
        if (!document || typeof document.addEventListener !== 'function') { return; }
        document.addEventListener('tildaform:aftersuccess', completedTildaAttempt);
        ['wpcf7mailsent', 'elementor:form:success', 'elementor:form:submit_success'].forEach(function (eventName) {
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
        installSubmitCapture();
        discoverForms(document);
        recoverNavigationAttempts();
        if (typeof document.addEventListener === 'function') {
            document.addEventListener('DOMContentLoaded', function () {
                discoverForms(document);
                recoverNavigationAttempts();
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
        version: '1.4.3', init: init, send: send, success: success, registerAdapter: registerAdapter,
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
