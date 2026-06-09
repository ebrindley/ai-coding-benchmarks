# go-kv-service fixture

Greenfield Go fixture: implement an in-memory key/value HTTP service from a stub.
Zero third-party dependencies — uses only the Go standard library (`net/http`,
`encoding/json`, `sync`) and the built-in `go test` runner.

- Implement the handler in `store.go` so all tests in `store_test.go` pass.
- Do not edit `store_test.go`.

Run:

```sh
go test ./...
```
