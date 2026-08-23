export const META_WHATSAPP_MESSAGE_ID_MAX_LENGTH = 506;

// Meta Cloud API message identifiers are opaque WAMIDs. Keep one contract for
// synchronous provider responses and later signed webhook events so an ID that
// can be persisted at acceptance can always be correlated during projection.
export const META_WHATSAPP_MESSAGE_ID_PATTERN = /^wamid\.[\x21-\x7e]{1,500}$/;
