package com.example.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

public final class OrderServiceTest {
  @Test
  void createOrderReservesInventoryAndSetsStatus() {
    var svc = new OrderService();
    svc.createOrder("o-1", "SKU-1", 2);
    assertEquals("CREATED:SKU-1:2", svc.getOrderStatus("o-1"));
  }

  @Test
  void createOrderOutOfStockFails() {
    var svc = new OrderService();
    assertThrows(IllegalStateException.class, () -> svc.createOrder("o-2", "SKU-2", 999));
  }

  @Test
  void cancelOrderRequiresExisting() {
    var svc = new OrderService();
    assertThrows(IllegalArgumentException.class, () -> svc.cancelOrder("missing"));
  }

  @Test
  void cancelOrderUpdatesStatus() {
    var svc = new OrderService();
    svc.createOrder("o-3", "SKU-1", 1);
    svc.cancelOrder("o-3");
    assertEquals("CANCELLED", svc.getOrderStatus("o-3"));
  }

  @Test
  void paymentRejectsNonPositiveAmounts() {
    var svc = new OrderService();
    assertThrows(IllegalArgumentException.class, () -> svc.processPayment("o-4", 0));
  }

  @Test
  void notificationRejectsUnknownChannel() {
    var svc = new OrderService();
    assertThrows(IllegalArgumentException.class, () -> svc.sendOrderNotification("o-5", "fax"));
  }
}

