package com.example;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Repository;

@Repository
public class InMemoryOrderRepository implements OrderRepository {
  private final ConcurrentHashMap<String, Order> store = new ConcurrentHashMap<>();

  @Override
  public List<Order> findAll() {
    return new ArrayList<>(store.values());
  }

  @Override
  public Optional<Order> findById(String id) {
    return Optional.ofNullable(store.get(id));
  }

  @Override
  public Order save(Order order) {
    store.put(order.id(), order);
    return order;
  }
}
