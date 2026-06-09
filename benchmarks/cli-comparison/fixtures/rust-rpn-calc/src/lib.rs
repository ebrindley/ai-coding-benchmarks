//! Greenfield task: implement a reverse-Polish-notation (RPN) calculator.
//!
//! `eval` takes a whitespace-separated RPN expression and returns the result.
//! Tokens are either integers (which may be negative, e.g. `-3`) or one of the
//! operators `+ - * /`. Evaluation uses a stack: push numbers; on an operator,
//! pop the top two values (the second-popped is the left operand) and push the
//! result.
//!
//! Error contract (return `Err` with these exact messages):
//!   - empty input                         -> "empty expression"
//!   - an operator with fewer than 2 values-> "stack underflow"
//!   - division by zero                     -> "division by zero"
//!   - a token that is neither int nor op   -> "invalid token: <token>"
//!   - leftover values (more than one) at end -> "invalid expression"
//!
//! Division is integer division. Use only the standard library.
//! Do not change the `eval` signature; do not edit the tests module.

pub fn eval(_expr: &str) -> Result<i64, String> {
    todo!("implement RPN evaluation")
}

#[cfg(test)]
mod tests {
    use super::eval;

    #[test]
    fn single_number() {
        assert_eq!(eval("42"), Ok(42));
    }

    #[test]
    fn simple_add() {
        assert_eq!(eval("2 3 +"), Ok(5));
    }

    #[test]
    fn subtraction_order() {
        // 5 1 - means 5 - 1
        assert_eq!(eval("5 1 -"), Ok(4));
    }

    #[test]
    fn multiplication_and_addition() {
        // 2 3 4 * + = 2 + (3*4) = 14
        assert_eq!(eval("2 3 4 * +"), Ok(14));
    }

    #[test]
    fn integer_division() {
        assert_eq!(eval("7 2 /"), Ok(3));
    }

    #[test]
    fn negative_numbers() {
        assert_eq!(eval("-3 4 +"), Ok(1));
    }

    #[test]
    fn chained() {
        // 10 2 / 3 - = (10/2) - 3 = 2
        assert_eq!(eval("10 2 / 3 -"), Ok(2));
    }

    #[test]
    fn empty_is_error() {
        assert_eq!(eval("   "), Err("empty expression".to_string()));
    }

    #[test]
    fn underflow_is_error() {
        assert_eq!(eval("2 +"), Err("stack underflow".to_string()));
    }

    #[test]
    fn divide_by_zero_is_error() {
        assert_eq!(eval("1 0 /"), Err("division by zero".to_string()));
    }

    #[test]
    fn invalid_token_is_error() {
        assert_eq!(eval("2 x +"), Err("invalid token: x".to_string()));
    }

    #[test]
    fn leftover_values_is_error() {
        assert_eq!(eval("1 2 3 +"), Err("invalid expression".to_string()));
    }
}
