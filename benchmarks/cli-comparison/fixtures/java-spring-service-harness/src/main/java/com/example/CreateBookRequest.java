package com.example;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

public record CreateBookRequest(
    @NotNull Long id,
    @NotBlank String title,
    @NotBlank String author
) {}
