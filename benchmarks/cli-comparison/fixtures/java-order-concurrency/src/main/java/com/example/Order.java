package com.example;

public record Order(String id, long productId, int quantity, String status) {}
