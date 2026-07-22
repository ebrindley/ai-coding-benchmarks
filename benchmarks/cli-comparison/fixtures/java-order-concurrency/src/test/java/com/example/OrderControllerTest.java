package com.example;

import static org.hamcrest.Matchers.is;
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
public class OrderControllerTest {
  @Autowired private MockMvc mvc;

  @Test
  void createProduct() throws Exception {
    mvc.perform(
            post("/products")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"name\":\"Widget\",\"stock\":10}"))
        .andExpect(status().isCreated())
        .andExpect(jsonPath("$.name", is("Widget")))
        .andExpect(jsonPath("$.stock", is(10)));
  }

  @Test
  void placeOrderReservesStock() throws Exception {
    long productId = createProduct("Gadget", 5);

    mvc.perform(
            post("/orders")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"productId\":" + productId + ",\"quantity\":3}"))
        .andExpect(status().isCreated())
        .andExpect(jsonPath("$.productId", is((int) productId)))
        .andExpect(jsonPath("$.quantity", is(3)))
        .andExpect(jsonPath("$.status", is("CONFIRMED")));

    mvc.perform(get("/products/" + productId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.stock", is(2)));
  }

  @Test
  void placeOrderRejectsInsufficientStock() throws Exception {
    long productId = createProduct("Sprocket", 1);

    mvc.perform(
            post("/orders")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"productId\":" + productId + ",\"quantity\":2}"))
        .andExpect(status().isConflict());

    mvc.perform(get("/products/" + productId))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.stock", is(1)));
  }

  @Test
  void placeOrderRejectsUnknownProduct() throws Exception {
    mvc.perform(
            post("/orders")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"productId\":999999,\"quantity\":1}"))
        .andExpect(status().isNotFound());
  }

  @Test
  void placeOrderValidatesQuantity() throws Exception {
    long productId = createProduct("Cog", 5);

    mvc.perform(
            post("/orders")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"productId\":" + productId + ",\"quantity\":0}"))
        .andExpect(status().isBadRequest());
  }

  private long createProduct(String name, int stock) throws Exception {
    String body =
        mvc.perform(
                post("/products")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"name\":\"" + name + "\",\"stock\":" + stock + "}"))
            .andExpect(status().isCreated())
            .andReturn()
            .getResponse()
            .getContentAsString();
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"id\":(\\d+)").matcher(body);
    if (!m.find()) {
      throw new IllegalStateException("no id in response: " + body);
    }
    return Long.parseLong(m.group(1));
  }
}
