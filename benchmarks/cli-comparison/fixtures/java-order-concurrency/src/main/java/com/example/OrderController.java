package com.example;

import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  @PostMapping("/products")
  public ResponseEntity<Product> createProduct(@Valid @RequestBody CreateProductRequest request) {
    Product created = service.addProduct(request.name(), request.stock());
    return ResponseEntity.status(HttpStatus.CREATED).body(created);
  }

  @GetMapping("/products/{id}")
  public Product getProduct(@PathVariable long id) {
    return service.getProduct(id);
  }

  @PostMapping("/orders")
  public ResponseEntity<Order> placeOrder(@Valid @RequestBody PlaceOrderRequest request) {
    Order created = service.placeOrder(request.productId(), request.quantity());
    return ResponseEntity.status(HttpStatus.CREATED).body(created);
  }
}
