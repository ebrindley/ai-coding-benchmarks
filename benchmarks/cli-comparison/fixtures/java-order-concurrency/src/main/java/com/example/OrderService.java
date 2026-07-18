package com.example;

import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Service;

/**
 * Places orders against product inventory.
 *
 * <p>Reserving stock is a read-check-write sequence: the current stock level is read, the requested
 * quantity is validated against it, and the decremented level is written back. The order record is
 * persisted as part of the same logical operation so that a confirmed order always corresponds to
 * reserved stock.
 */
@Service
public class OrderService {
  private final ProductRepository productRepository;
  private final OrderRepository orderRepository;
  private final AtomicLong productSequence = new AtomicLong();
  private final AtomicLong orderSequence = new AtomicLong();

  public OrderService(ProductRepository productRepository, OrderRepository orderRepository) {
    this.productRepository = productRepository;
    this.orderRepository = orderRepository;
  }

  public Product addProduct(String name, int initialStock) {
    if (initialStock < 0) {
      throw new IllegalArgumentException("initialStock must be non-negative");
    }
    long id = productSequence.incrementAndGet();
    return productRepository.save(new Product(id, name, initialStock));
  }

  public Product getProduct(long productId) {
    return productRepository
        .findById(productId)
        .orElseThrow(() -> new ProductNotFoundException(productId));
  }

  /**
   * Reserves {@code quantity} units of {@code productId} and records a confirmed order.
   *
   * @throws ProductNotFoundException if the product does not exist
   * @throws InsufficientStockException if not enough stock is available
   */
  public Order placeOrder(long productId, int quantity) {
    if (quantity <= 0) {
      throw new IllegalArgumentException("quantity must be positive");
    }

    Product product =
        productRepository
            .findById(productId)
            .orElseThrow(() -> new ProductNotFoundException(productId));

    // Read the current stock level, then validate the request against it.
    int available = product.stock();
    if (available < quantity) {
      throw new InsufficientStockException(productId, quantity, available);
    }

    // Persist the confirmed order, then write the decremented stock level back. The stock write is
    // derived from the value read above rather than from the repository's current state.
    String orderId = "ord-" + orderSequence.incrementAndGet();
    Order order = new Order(orderId, productId, quantity, "CONFIRMED");
    orderRepository.save(order);

    Product updated = product.withStock(available - quantity);
    productRepository.save(updated);

    return order;
  }
}
