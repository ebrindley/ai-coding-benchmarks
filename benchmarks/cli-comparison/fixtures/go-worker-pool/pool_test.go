package workerpool

import "testing"

func wantSum(n int) int {
	total := 0
	for i := 1; i <= n; i++ {
		total += i * i
	}
	return total
}

func TestSmall(t *testing.T) {
	if got, want := SumSquares(3, 2), 14; got != want { // 1+4+9
		t.Fatalf("SumSquares(3,2) = %d, want %d", got, want)
	}
}

func TestCorrectAcrossSizes(t *testing.T) {
	cases := []struct{ n, workers int }{
		{0, 1}, {1, 1}, {10, 1}, {10, 4}, {100, 8}, {1000, 16},
	}
	for _, c := range cases {
		if got, want := SumSquares(c.n, c.workers), wantSum(c.n); got != want {
			t.Errorf("SumSquares(%d,%d) = %d, want %d", c.n, c.workers, got, want)
		}
	}
}

// Repeated runs make a racy accumulator fail reliably even without -race.
func TestRepeatableUnderConcurrency(t *testing.T) {
	want := wantSum(500)
	for iter := 0; iter < 200; iter++ {
		if got := SumSquares(500, 8); got != want {
			t.Fatalf("iteration %d: SumSquares(500,8) = %d, want %d", iter, got, want)
		}
	}
}

func TestZeroWorkersDefaultsToOne(t *testing.T) {
	if got, want := SumSquares(5, 0), wantSum(5); got != want {
		t.Fatalf("SumSquares(5,0) = %d, want %d", got, want)
	}
}
