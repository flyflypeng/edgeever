/**
 * The page runs as an opaque origin: scripts, forms, dialogs, popups and
 * downloads work, but it can never reach EdgeEver's cookies, storage or DOM,
 * and it cannot navigate the app. Do not add allow-same-origin or
 * allow-top-navigation*: either one breaks that isolation.
 */
export const HTML_ARTIFACT_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";
