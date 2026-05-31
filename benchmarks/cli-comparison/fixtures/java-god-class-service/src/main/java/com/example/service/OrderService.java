package com.example.service;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Intentionally-monolithic "god class" for the refactor benchmark.
 * It mixes order lifecycle, inventory, payments, and notifications.
 */
public final class OrderService {
  private final Map<String, String> orders = new HashMap<>();
  private final Map<String, Integer> stock = new HashMap<>();
  private final Map<String, Integer> payments = new HashMap<>();
  private final Map<String, String> notifications = new HashMap<>();

  public OrderService() {
    stock.put("SKU-1", 10);
    stock.put("SKU-2", 5);
  }

  // Public API (must remain unchanged during refactor)

  public String createOrder(String orderId, String sku, int quantity) {
    validateOrderId(orderId);
    validateSku(sku);
    validateQuantity(quantity);
    reserveInventory(sku, quantity);
    orders.put(orderId, "CREATED:" + sku + ":" + quantity);
    return orderId;
  }

  public void cancelOrder(String orderId) {
    validateOrderId(orderId);
    String existing = orders.get(orderId);
    if (existing == null) {
      throw new IllegalArgumentException("order not found");
    }
    orders.put(orderId, "CANCELLED");
  }

  public String getOrderStatus(String orderId) {
    validateOrderId(orderId);
    String status = orders.get(orderId);
    if (status == null) return "NOT_FOUND";
    return status;
  }

  public void reserveInventory(String sku, int quantity) {
    validateSku(sku);
    validateQuantity(quantity);
    int available = stock.getOrDefault(sku, 0);
    if (available < quantity) {
      throw new IllegalStateException("out of stock");
    }
    stock.put(sku, available - quantity);
  }

  public void processPayment(String orderId, int cents) {
    validateOrderId(orderId);
    if (cents <= 0) throw new IllegalArgumentException("invalid amount");
    payments.put(orderId, cents);
  }

  public void sendOrderNotification(String orderId, String channel) {
    validateOrderId(orderId);
    if (!Objects.equals(channel, "email") && !Objects.equals(channel, "sms")) {
      throw new IllegalArgumentException("invalid channel");
    }
    notifications.put(orderId, "sent:" + channel);
  }

  // Helpers (private)

  private void validateOrderId(String orderId) {
    if (orderId == null || orderId.isBlank()) throw new IllegalArgumentException("invalid orderId");
  }

  private void validateSku(String sku) {
    if (sku == null || sku.isBlank()) throw new IllegalArgumentException("invalid sku");
  }

  private void validateQuantity(int quantity) {
    if (quantity <= 0) throw new IllegalArgumentException("invalid quantity");
  }
}

