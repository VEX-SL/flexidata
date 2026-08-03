/**
 * Real OCR output of a SuperPay card-payment receipt (prod upload
 * photo_2026-08-02_12-59-10.jpg), normalized only by dropping the bidi
 * control characters Tesseract emitted. All other artifacts (garbled Arabic,
 * misread year 2028, mixed scripts) are preserved as-is.
 */
export const SUPERYPAY_RECEIPT_OCR = `i م 0 5 ل 1 3 : = : ب"
له SuperPay 60
LL 15468
Zahra Aman =
3 قوري باي
() رقم التمليه : 6070218301132167
تبيخ الوقت : 02-07-2028 18:30:12
| رقم الحساب : 391803452
B انرقم المرجقي : 2013438351
[ عملية ناجحة
8[ رقم العميل : 9840833767
§ معلومات إضافية : Mobile Number
Hostinger;Description © ;)0123456788(
F- 1 :
X PURCHASE 8
gla المطلوب : 68.38 ;
glad | العلى : 68.38
: 3 عند لفطل EAN قد يستفرق a se BA`;
