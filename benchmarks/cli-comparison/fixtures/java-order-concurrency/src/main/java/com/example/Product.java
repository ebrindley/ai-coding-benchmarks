package com.example;

public record Product(long id, String name, int stock) {
  public Product withStock(int newStock) {
    return new Product(id, name, newStock);
  }
}
