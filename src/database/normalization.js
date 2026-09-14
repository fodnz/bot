const PHONE_SUFFIX = "@s.whatsapp.net";

function normalizeString(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized || null;
}

export function normalizeJid(value) {
    const input = normalizeString(value);
    if (!input) return null;

    let jid = input;
    jid = jid.replace(/(?:@s\.whatsapp\.net)+$/i, PHONE_SUFFIX);
    jid = jid.replace(/(?:@c\.us)+$/i, PHONE_SUFFIX);
    jid = jid.replace(/@lid@lid$/i, "@lid");
    return jid;
}

export function normalizePhoneJid(value) {
    const input = normalizeString(value);
    if (!input) return null;
    if (/^\d+$/.test(input)) return `${input}${PHONE_SUFFIX}`;

    const jid = normalizeJid(input);
    if (!jid) return null;

    if (jid.endsWith(PHONE_SUFFIX)) {
        const at = jid.indexOf("@");
        const local = at > 0 ? jid.slice(0, at) : jid;
        const deviceSeparator = local.indexOf(":");
        const phone = deviceSeparator >= 0 ? local.slice(0, deviceSeparator) : local;
        return /^\d+$/.test(phone) ? `${phone}${PHONE_SUFFIX}` : jid;
    }

    return jid;
}

export function normalizePhoneNumber(value) {
    const input = normalizeString(value);
    if (!input) return null;
    if (/^\d+$/.test(input)) return input;

    const jid = normalizePhoneJid(input);
    if (!jid || !jid.endsWith(PHONE_SUFFIX)) return null;
    return jid.slice(0, -PHONE_SUFFIX.length).split(":", 1)[0] || null;
}

export function normalizeIdentifier(value) {
    const jid = normalizeJid(value);
    if (!jid) return null;
    if (/^\d+$/.test(jid)) return `${jid}${PHONE_SUFFIX}`;
    return jid;
}

export function identifierType(value) {
    const jid = normalizeIdentifier(value);
    if (!jid) return "jid";
    const at = jid.indexOf("@");
    const local = at >= 0 ? jid.slice(0, at) : jid;
    const server = at >= 0 ? jid.slice(at) : "";

    if (server === "@lid") return "lid";
    if (server === PHONE_SUFFIX) return local.includes(":") ? "device_jid" : "pn";
    return "jid";
}

export function primaryJid(value) {
    const jid = normalizeIdentifier(value);
    if (!jid) return null;
    const at = jid.indexOf("@");
    if (at < 0) return jid;
    const local = jid.slice(0, at);
    const server = jid.slice(at);
    const separator = local.indexOf(":");
    return separator >= 0 ? `${local.slice(0, separator)}${server}` : jid;
}

export function uniqueIdentifiers(values) {
    const result = [];
    const seen = new Set();

    for (const value of values) {
        const normalized = normalizeIdentifier(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }

    return result;
}
