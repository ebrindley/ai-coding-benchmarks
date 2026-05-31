package com.example;

import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class BookService {
  private final BookRepository repository;

  public BookService(BookRepository repository) {
    this.repository = repository;
  }

  public List<Book> getAllBooks() {
    return repository.findAll();
  }

  public Book getBookById(long id) {
    return repository.findById(id).orElseThrow(() -> new BookNotFoundException(id));
  }

  public Book createBook(CreateBookRequest request) {
    throw new UnsupportedOperationException("TODO: implement createBook");
  }

  public void deleteBook(long id) {
    throw new UnsupportedOperationException("TODO: implement deleteBook");
  }
}
