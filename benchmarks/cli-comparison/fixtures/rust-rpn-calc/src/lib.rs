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
//! Do not change the `eval` signature. Tests live under `tests/` (protected);
//! do not edit them.

pub fn eval(_expr: &str) -> Result<i64, String> {
    todo!("implement RPN evaluation")
}
