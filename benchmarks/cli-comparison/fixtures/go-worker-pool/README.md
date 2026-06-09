# go-worker-pool fixture

Brownfield Go fixture: a parallel sum-of-squares worker pool with a concurrency
bug. Zero third-party dependencies — standard library plus `go test`.

`SumSquares` fans work out to N goroutines and accumulates the result. It returns
the right answer sometimes and the wrong answer other times: there is a data race
on the shared accumulator (and the wait logic is unsound).

- Fix `pool.go` so the result is correct and the code is race-free.
- Do not edit `pool_test.go`.

Run (the race detector gate is what catches this bug deterministically):

```sh
go test -race ./...
```
