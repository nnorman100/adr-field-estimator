// The header a link token travels in (S5a-11b), for the server and the browser alike. Its own module
// so the browser pages never import the server's token code.
export const LINK_TOKEN_HEADER = 'x-link-token';
