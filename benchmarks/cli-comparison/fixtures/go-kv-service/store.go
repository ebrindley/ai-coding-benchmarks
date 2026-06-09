// Greenfield task: implement an in-memory key/value HTTP service.
//
// Implement NewHandler so it returns an http.Handler backing a concurrency-safe
// string->string store with this JSON/REST contract (all bodies are JSON):
//
//   PUT  /keys/{key}   body {"value":"..."}  -> 204 No Content
//                                              -> 400 if body is missing "value"
//   GET  /keys/{key}                          -> 200 {"value":"..."}
//                                              -> 404 if the key is absent
//   DELETE /keys/{key}                        -> 204 if it existed
//                                              -> 404 if the key is absent
//   GET  /keys                                -> 200 {"keys":[...]} sorted ascending
//
// The store must be safe for concurrent use. Use only the standard library.
//
// Do not change the NewHandler signature; do not edit store_test.go.

package kvservice

import "net/http"

// NewHandler returns the HTTP handler for the key/value service.
func NewHandler() http.Handler {
	panic("TODO: implement")
}
