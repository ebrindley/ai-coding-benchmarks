package com.example;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Repository;

@Repository
public class InMemoryBookRepository implements BookRepository {
  private final ConcurrentHashMap<Long, Book> store = new ConcurrentHashMap<>();

  @Override
  public List<Book> findAll() {
    return new ArrayList<>(store.values());
  }

  @Override
  public Optional<Book> findById(long id) {
    return Optional.ofNullable(store.get(id));
  }

  @Override
  public Book save(Book book) {
    store.put(book.id(), book);
    return book;
  }

  @Override
  public void deleteById(long id) {
    store.remove(id);
  }
}
