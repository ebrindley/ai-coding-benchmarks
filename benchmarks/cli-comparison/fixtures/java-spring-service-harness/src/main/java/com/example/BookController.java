package com.example;

import java.util.List;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/books")
public class BookController {
  private final BookService service;

  public BookController(BookService service) {
    this.service = service;
  }

  @GetMapping
  public List<Book> getAllBooks() {
    return service.getAllBooks();
  }

  @GetMapping("/{id}")
  public Book getBookById(@PathVariable long id) {
    return service.getBookById(id);
  }

  @PostMapping
  public ResponseEntity<Book> createBook(@Valid @RequestBody CreateBookRequest request) {
    Book created = service.createBook(request);
    return ResponseEntity.status(HttpStatus.CREATED).body(created);
  }

  @DeleteMapping("/{id}")
  public ResponseEntity<Void> deleteBook(@PathVariable long id) {
    service.deleteBook(id);
    return ResponseEntity.status(HttpStatus.NO_CONTENT).build();
  }
}
