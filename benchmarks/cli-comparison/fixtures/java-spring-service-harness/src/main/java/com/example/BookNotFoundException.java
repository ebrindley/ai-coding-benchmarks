package com.example;

public class BookNotFoundException extends RuntimeException {
  public BookNotFoundException(long id) {
    super("Book not found: " + id);
  }
}
