package com.example;

import java.util.List;
import java.util.Optional;

public interface OrderRepository {
  List<Order> findAll();

  Optional<Order> findById(String id);

  Order save(Order order);
}
