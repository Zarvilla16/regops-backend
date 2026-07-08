import { registerDecorator, ValidationOptions } from "class-validator";

const ELEVEN_DIGIT_REGEX = /^\d{11}$/;

/** BVN and NIN must be exactly 11 numeric digits — used on both CreateCustomerDto/UpdateCustomerDto and the CSV row schema. */
export function IsElevenDigitId(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isElevenDigitId",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "string" && ELEVEN_DIGIT_REGEX.test(value);
        },
        defaultMessage(): string {
          return `${propertyName} must be exactly 11 numeric digits`;
        },
      },
    });
  };
}
