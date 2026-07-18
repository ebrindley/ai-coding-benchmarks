package com.example;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

public record PlaceOrderRequest(
    @NotNull Long productId,
    @NotNull @Positive Integer quantity
) {}
