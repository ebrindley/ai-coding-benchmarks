// Brownfield task: this worker pool has a concurrency bug.
//
// SumSquares computes the sum of i*i for i in [1..n] by fanning the work out to
// `workers` goroutines. It is wrong: multiple goroutines update the shared
// `total` without synchronization (a data race), and the function does not wait
// for the workers to finish before returning, so it can return a partial sum.
//
// Fix it so the result is always correct and `go test -race` reports no races.
// Keep the SumSquares signature and the parallel fan-out; do not collapse it to a
// single-threaded loop. Do not edit pool_test.go.

package workerpool

// SumSquares returns 1*1 + 2*2 + ... + n*n, computed across `workers` goroutines.
func SumSquares(n, workers int) int {
	if workers < 1 {
		workers = 1
	}
	total := 0
	jobs := make(chan int)

	for w := 0; w < workers; w++ {
		go func() {
			for i := range jobs {
				total += i * i
			}
		}()
	}

	for i := 1; i <= n; i++ {
		jobs <- i
	}
	close(jobs)

	return total
}
