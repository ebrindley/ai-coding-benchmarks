package com.example;

import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.is;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
public class BookControllerTest {
  @Autowired private MockMvc mvc;

  @Test
  void getAllBooks() throws Exception {
    mvc.perform(get("/books"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$", hasSize(0)));
  }

  @Test
  void createBook() throws Exception {
    // Contract: POST /books must return exactly HTTP 201 Created (not 200/2xx generic).
    mvc.perform(
            post("/books")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"id\":1,\"title\":\"Test Book\",\"author\":\"Test Author\"}"))
        .andExpect(status().is(201))
        .andExpect(jsonPath("$.id", is(1)))
        .andExpect(jsonPath("$.title", is("Test Book")));
  }

  @Test
  void getBookById() throws Exception {
    mvc.perform(
            post("/books")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"id\":1,\"title\":\"Test Book\",\"author\":\"Test Author\"}"))
        .andExpect(status().is(201));

    mvc.perform(get("/books/1"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.id", is(1)))
        .andExpect(jsonPath("$.title", is("Test Book")));
  }

  @Test
  void deleteBook() throws Exception {
    mvc.perform(
            post("/books")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"id\":1,\"title\":\"Test Book\",\"author\":\"Test Author\"}"))
        .andExpect(status().is(201));

    mvc.perform(delete("/books/1")).andExpect(status().isNoContent());
    mvc.perform(get("/books/1")).andExpect(status().isNotFound());
  }

  @Test
  void validation() throws Exception {
    mvc.perform(post("/books").contentType(MediaType.APPLICATION_JSON).content("{\"id\":1}"))
        .andExpect(status().isBadRequest());
  }
}
