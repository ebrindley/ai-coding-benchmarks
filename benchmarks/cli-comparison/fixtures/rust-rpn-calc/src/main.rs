use rust_rpn_calc::eval;
use std::env;
use std::process;

fn main() {
    let expr = env::args().skip(1).collect::<Vec<_>>().join(" ");
    match eval(&expr) {
        Ok(value) => println!("{value}"),
        Err(msg) => {
            eprintln!("error: {msg}");
            process::exit(1);
        }
    }
}
