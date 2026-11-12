function stripUnapprovedRetailData(product) {
  const value = product && typeof product.toObject === "function"
    ? product.toObject()
    : { ...product };
  delete value.price;
  delete value.offerPrice;
  delete value.quantity;
  return value;
}

module.exports = { stripUnapprovedRetailData };
