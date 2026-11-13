'use strict';
// Fictional letters in the layouts used by card brands and labs. Vendor,
// devices, numbers and people are invented ("Northwind Terminals").

const amex = `May 22, 2024

Northwind Terminals Attn: Pat Doe 1 Main Street, Springfield

Approval Number: 42.LABX.NORTHWIND.NX200.20240522-F

RE: Expresspay 4.2 Reader Certification

Product Name: NX200 Firmware Version: 01.00 As Tested in: NX200

Dear Pat,

We are pleased to inform you that American Express has certified the NX200 for Expresspay 4.2 using Firmware Version 01.00. This Expresspay 4.2 certification is valid for three years from the date of issuance.

Sincerely,

Network and Acquirer Solutions American Express`;

const discover = `Pat Doe Northwind Terminals 1 Main Street

January 5, 2026

Re: Discover D-PAS – Type Approval Letter

Vendor: Northwind Terminals Vendor Reference Number: R_0001 D-PAS Specification Version: D-PAS Contactless v2.0 Product: Flex/3XXX CL1 Product Reference Number: NW_FLEX3XXX_CTL_2021 Hardware Version: HW1 Firmware Version: SW 1.0 Kernel Version: 123 v0406 Approval Expiration Date: January 5, 2029

Dear Pat:

Discover hereby confirms its type approval of the Product.

Please note that this approval will expire on January 5, 2029 ("Expiration Date").

Sincerely,

Discover Network`;

const emvco = `January 10, 2024

Re: EMVCo Letter of Approval - Contact Terminal Level 1

Approval Number(s): 12345 0124 430 43a 43a LABX

Terminal: NX100 PinPad: none

As tested in: NX100 Version 1.0

Renewal Date: June 30, 2028

Dear Pat,

EMVCo has reviewed the test results.

Sincerely, EMVCo`;

const mastercard = `Mastercard 2000 Purchase Street

Northwind Terminals 1 Main Street

April 15, 2025 Mastercard Contactless Reader Vendor Product – Letter of Approval

LoA Identifier: TLOA-NW250415(a) Product Vendor: Northwind Terminals LoA Expiration Date: September 5, 2028

Product Identification Fully Integrated Terminal Product Commercial Name NX200 & NX300 Product Technical Name NX200 & NX300 version MCL4.0

Sincerely, Mastercard`;

const pci = `PCI Security Standards Council Letter of Approval

PTS Approval Number: 4-12345

Approval Date: Effective Date: June 21, 2024 Expiry Date: April 30, 2031

Device Name & Model Number: NX100 Hardware #: HW1

Approved under PCI PTS POI Modular Security Requirements v6.1

Sincerely, PCI Security Standards Council`;

const bulletin = `EMV Level 1 Contact - Product Configuration Bulletin

NX100

Date: 03 Jan 2025

This bulletin describes the configuration of the approved interface.`;

// A bulletin table laid out the way PDF text extraction prints it: cells wrap
// above and below the row's reference line, and one device (NX500) has a CT1
// row of its own while its CT2 units share the first row.
const bulletinTable = `EMV Level 1 Contact - Product Configuration Bulletin
NX400, NX600, NX500, NX500 LE
Date: 02 June 2026

IFM identification - NX400, NX600, NX500, NX500 LE

IFM ID   IFM ID HW   Specification   LoA ref   Expiry date   List of Products covered   PCI-PTS   TQM Label (Terminal Quality
Management)
NX400,   NX500 LE:
NX600,   NWA7xxxxY
NX500   NX400:   v6.x
LE   NWIFM2 v1.0   NWIFM2 HW v01.01   EMV v1.0   10001 0122 430 43c 43c LABX   13 Jan 2030   TQM9001/02   01 Feb. 2027
NX600: NWD7xxxxY
NX500 CT2:
v5.x
CT2
NWIFM1 v1.0   NX500 : NWR3xxxxY   NX500 CT1:
NX500
NWIFM1 HW v01.01   EMV v4.3   10002 0914 400 21 LAB   18 Sep 2026   v5.x   TQM9002/04   01 Feb 2027
CT1   NWIFM1 v1.3 (qualified)

1/1 Product Configuration Bulletin IFM NX400, NX600, NX500, NX500 LE`;

const mastercardKernel = `Mastercard 2000 Purchase Street

Northwind Terminals 1 Main Street

April 15, 2025 Mastercard Contactless Reader Vendor Product – Letter of Approval

LoA Identifier: TLOA-NW250416(a) Product Vendor: Northwind Terminals LoA Expiration Date: September 5, 2028

Product Commercial Name NX200 Product Technical Name NX200 version MCL4.0
Application Selection Module             NW.EP version 050100
Mastercard Contactless Kernel            NW.C2 version 100100

Sincerely, Mastercard`;

// Manufacturer validity letters (fictional "Nimbus" families).
const validityContact = `                                                         Northwind Terminals
                                                         1 Main Street, Springfield

 Ref. /        NWT-000111-001                                  Springfield, 11 April 2024

 Subject / EMV contact LoA validity on the Nimbus family of products

To whom it may concern,

The Nimbus Architecture enables the same binary to run on each Terminal model.
I hereby certify that all hardware variants of the products of the Nimbus family are minor
changes according to EMVCo Type Approval Bulletin N° 11 of June 2021. Therefore, EMVCo
Letters of Approval for Northwind EMV contact kernels approved on a Nimbus terminal are
valid on any other product of the Nimbus family1.

Among others, the following products are covered by this letter:
    - Nim/1000, Nim/2000, Nim/3000
    - Cloud/500
    - Rain/7000 with Tetra terminal

Yours faithfully,

Pat Doe
Level 2 Certification Manager
1 Only the kernel NW.EMV.Contact Version 09.06 and future versions can be used on
configurations with Nim/1600 and Rain/8000
`;

const validityContactless = `                                                         Northwind Terminals

Ref. /        NWT-000111-002                                  Springfield, 27 August 2026

Subject / Contactless kernels compatibility on the NWX family of products

To whom it may concern,

I hereby certify that the behaviour of existing contactless kernels is not affected throughout
the different models of the NWX platform, including the NWX Next-Gen products.

In particular the kernels listed in kernel_list, run identically on the terminals listed in
Product_list.

Kernel_list:
              Specification                   kernel                          Compatibility1
         -    Mastercard MCL4.0 / 4.1         kernel PAYPASS_L2 04.04         NWX / NWX Next-Gen
         -    MasterCard MCL3.1.4             kernel PAYPASS_L2 04.03         NWX
         -    Visa payWave 2.2:               kernel 1234567890 versions 070000 and 070803
         -    UPI QuickPass                   kernel Quickpass_L2_03.03       NWX / NWX Next-Gen
         -    Discover D-PAS 1.0:             kernels 844557-0311 (and kernel ZIP 846004-0200)

1 The compatibility is not due to any technical limitation. Old version of the kernels cannot be
certified on NWX Next-Gen because of payment schemes regulations.

\f
Product_list :

                      NWX                                                  NWX Next-Gen
       -      NWX DX4000                                           -   NWX DX2
       -      NWX DX8000                                           -   NWX DX8
       -      NWX SX7000

However, most of approvals are provided by product. You need to check with your contact if a
particular couple {terminal, kernel version} is approved. We warn you to take care of the version
of PCD for each product.
`;

module.exports = { amex, discover, emvco, mastercard, pci, bulletin, bulletinTable, mastercardKernel, validityContact, validityContactless };
