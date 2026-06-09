package kvservice

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(NewHandler())
	t.Cleanup(srv.Close)
	return srv
}

func put(t *testing.T, base, key string, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, base+"/keys/"+key, bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestPutThenGet(t *testing.T) {
	srv := newServer(t)
	if resp := put(t, srv.URL, "alpha", `{"value":"one"}`); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("put status = %d, want 204", resp.StatusCode)
	}
	resp, err := http.Get(srv.URL + "/keys/alpha")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d, want 200", resp.StatusCode)
	}
	var got map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["value"] != "one" {
		t.Fatalf("value = %q, want %q", got["value"], "one")
	}
}

func TestGetMissingIs404(t *testing.T) {
	srv := newServer(t)
	resp, err := http.Get(srv.URL + "/keys/nope")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestPutRejectsMissingValue(t *testing.T) {
	srv := newServer(t)
	resp := put(t, srv.URL, "k", `{"notvalue":"x"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestOverwrite(t *testing.T) {
	srv := newServer(t)
	put(t, srv.URL, "k", `{"value":"first"}`)
	put(t, srv.URL, "k", `{"value":"second"}`)
	resp, _ := http.Get(srv.URL + "/keys/k")
	var got map[string]string
	json.NewDecoder(resp.Body).Decode(&got)
	if got["value"] != "second" {
		t.Fatalf("value = %q, want %q", got["value"], "second")
	}
}

func TestDelete(t *testing.T) {
	srv := newServer(t)
	put(t, srv.URL, "k", `{"value":"v"}`)

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/keys/k", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d, want 204", resp.StatusCode)
	}

	resp2, _ := http.Get(srv.URL + "/keys/k")
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("get-after-delete = %d, want 404", resp2.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodDelete, srv.URL+"/keys/k", nil)
	resp3, _ := http.DefaultClient.Do(req2)
	if resp3.StatusCode != http.StatusNotFound {
		t.Fatalf("delete-missing = %d, want 404", resp3.StatusCode)
	}
}

func TestListKeysSorted(t *testing.T) {
	srv := newServer(t)
	put(t, srv.URL, "charlie", `{"value":"3"}`)
	put(t, srv.URL, "alpha", `{"value":"1"}`)
	put(t, srv.URL, "bravo", `{"value":"2"}`)

	resp, err := http.Get(srv.URL + "/keys")
	if err != nil {
		t.Fatal(err)
	}
	var got map[string][]string
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	want := []string{"alpha", "bravo", "charlie"}
	if len(got["keys"]) != len(want) {
		t.Fatalf("keys = %v, want %v", got["keys"], want)
	}
	for i := range want {
		if got["keys"][i] != want[i] {
			t.Fatalf("keys = %v, want %v", got["keys"], want)
		}
	}
}

func TestConcurrentWritesAreSafe(t *testing.T) {
	srv := newServer(t)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			put(t, srv.URL, "shared", `{"value":"v"}`)
		}(i)
	}
	wg.Wait()
	resp, _ := http.Get(srv.URL + "/keys/shared")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}
