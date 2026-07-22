package com.example;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.BrokenBarrierException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * Deterministically exercises concurrent stock reservation.
 *
 * <p>These tests build the service directly against in-memory repositories so no Spring context is
 * required. The product repository is wrapped in a {@link BarrierProductRepository} that pauses each
 * thread on the repository <em>read</em> until all contending threads have read the same stock
 * value. That forces the read-check-write windows to overlap regardless of the host scheduler (a
 * plain start latch only aligns entry into the action, which a single-vCPU / serialized scheduler
 * can still run one-at-a-time). With overlap forced, a lost-update / check-then-act race in {@code
 * placeOrder} is surfaced on every round.
 *
 * <p>The barrier is safe for a correct fix: a fix that serializes the critical section prevents the
 * reads from overlapping, so the barrier trips its timeout exactly once, breaks, and every later
 * read returns immediately. Correct implementations therefore satisfy the conservation invariant
 * {@code initialStock == finalStock + confirmedUnits} without stalling.
 */
public final class OrderConcurrencyTest {
  private static final int ROUNDS = 25;
  private static final int THREADS = 64;

  /** Bundles the service with the order repository so tests can assert persistence. */
  private record Fixture(OrderService service, OrderRepository orders) {}

  private Fixture newFixture(CyclicBarrier readBarrier) {
    ProductRepository products =
        new BarrierProductRepository(new InMemoryProductRepository(), readBarrier);
    OrderRepository orders = new InMemoryOrderRepository();
    return new Fixture(new OrderService(products, orders), orders);
  }

  @Test
  void stockIsConservedUnderConcurrentReservation() throws Exception {
    for (int round = 0; round < ROUNDS; round++) {
      CyclicBarrier readBarrier = new CyclicBarrier(THREADS);
      Fixture fixture = newFixture(readBarrier);
      OrderService service = fixture.service();
      Product product = service.addProduct("widget", THREADS);

      AtomicInteger confirmed = new AtomicInteger();
      runContended(
          THREADS,
          () -> {
            service.placeOrder(product.id(), 1);
            confirmed.incrementAndGet();
          });

      int finalStock = service.getProduct(product.id()).stock();
      assertEquals(
          THREADS,
          finalStock + confirmed.get(),
          "round "
              + round
              + ": conservation violated (stock="
              + finalStock
              + ", confirmed="
              + confirmed.get()
              + ", initial="
              + THREADS
              + ")");
      assertEquals(0, finalStock, "round " + round + ": stock should be fully reserved");
      // A persisted order must correspond to a reserved unit: no orphan orders
      // from a reservation that later failed, and no confirmed reservation without
      // a saved order.
      assertEquals(
          confirmed.get(),
          fixture.orders().findAll().size(),
          "round " + round + ": persisted order count must equal confirmed reservations");
    }
  }

  @Test
  void inventoryIsNotOversoldUnderContention() throws Exception {
    int capacity = THREADS / 2;
    for (int round = 0; round < ROUNDS; round++) {
      CyclicBarrier readBarrier = new CyclicBarrier(THREADS);
      Fixture fixture = newFixture(readBarrier);
      OrderService service = fixture.service();
      Product product = service.addProduct("gadget", capacity);

      AtomicInteger confirmed = new AtomicInteger();
      runContended(
          THREADS,
          () -> {
            try {
              service.placeOrder(product.id(), 1);
              confirmed.incrementAndGet();
            } catch (InsufficientStockException ignored) {
              // Expected once stock is exhausted.
            }
          });

      int finalStock = service.getProduct(product.id()).stock();
      assertEquals(
          capacity,
          confirmed.get(),
          "round " + round + ": oversold (confirmed=" + confirmed.get() + ", capacity=" + capacity + ")");
      // The failed reservations (THREADS - capacity of them) must not leave orphan
      // orders behind: only successful reservations may persist an order.
      assertEquals(
          confirmed.get(),
          fixture.orders().findAll().size(),
          "round " + round + ": persisted order count must equal confirmed reservations (no orphans)");
      assertEquals(0, finalStock, "round " + round + ": stock should be exhausted");
      assertTrue(finalStock >= 0, "round " + round + ": stock went negative");
    }
  }

  private static void runContended(int threads, Runnable action) throws InterruptedException {
    ExecutorService pool = Executors.newFixedThreadPool(threads);
    try {
      CountDownLatch ready = new CountDownLatch(threads);
      CountDownLatch start = new CountDownLatch(1);
      CountDownLatch done = new CountDownLatch(threads);
      for (int i = 0; i < threads; i++) {
        pool.submit(
            () -> {
              ready.countDown();
              try {
                start.await();
                action.run();
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
              } finally {
                done.countDown();
              }
            });
      }
      ready.await();
      start.countDown();
      assertTrue(done.await(60, TimeUnit.SECONDS), "workers did not finish in time");
    } finally {
      pool.shutdownNow();
    }
  }

  /**
   * Product repository decorator that pauses on each read until all contending threads have read,
   * forcing their read-check-write windows to overlap. Once the barrier has been broken (which
   * happens the first time a correctly-serialized fix prevents a full set of concurrent readers from
   * gathering within the timeout), every subsequent read returns immediately.
   */
  private static final class BarrierProductRepository implements ProductRepository {
    private static final long GATHER_TIMEOUT_MILLIS = 250;

    private final ProductRepository delegate;
    private final CyclicBarrier readBarrier;

    BarrierProductRepository(ProductRepository delegate, CyclicBarrier readBarrier) {
      this.delegate = delegate;
      this.readBarrier = readBarrier;
    }

    @Override
    public List<Product> findAll() {
      return delegate.findAll();
    }

    @Override
    public Optional<Product> findById(long id) {
      Optional<Product> result = delegate.findById(id);
      // Pause after reading so concurrent readers observe the same stock value. If the readers
      // cannot all gather (e.g. a correct fix serializes the critical section), the barrier breaks
      // once and thereafter returns instantly, so correct fixes are never stalled or failed.
      if (!readBarrier.isBroken()) {
        try {
          readBarrier.await(GATHER_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (TimeoutException | BrokenBarrierException ignored) {
          // Barrier broke because readers could not gather; proceed without overlap.
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
      }
      return result;
    }

    @Override
    public Product save(Product product) {
      return delegate.save(product);
    }
  }
}
