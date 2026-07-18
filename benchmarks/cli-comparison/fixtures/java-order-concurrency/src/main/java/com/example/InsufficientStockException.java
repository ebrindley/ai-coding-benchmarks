package com.example;

public class InsufficientStockException extends RuntimeException {
  public InsufficientStockException(long productId, int requested, int available) {
    super(
        "Insufficient stock for product "
            + productId
            + ": requested "
            + requested
            + ", available "
            + available);
  }
}
