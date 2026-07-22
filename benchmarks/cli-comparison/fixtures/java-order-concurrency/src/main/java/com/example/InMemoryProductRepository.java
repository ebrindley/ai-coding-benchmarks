package com.example;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Repository;

@Repository
public class InMemoryProductRepository implements ProductRepository {
  private final ConcurrentHashMap<Long, Product> store = new ConcurrentHashMap<>();

  @Override
  public List<Product> findAll() {
    return new ArrayList<>(store.values());
  }

  @Override
  public Optional<Product> findById(long id) {
    return Optional.ofNullable(store.get(id));
  }

  @Override
  public Product save(Product product) {
    store.put(product.id(), product);
    return product;
  }
}
