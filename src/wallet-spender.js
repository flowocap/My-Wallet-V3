var assert = require('assert');
var Bitcoin = require('bitcoinjs-lib');
var RSVP = require('rsvp');
var MyWallet = require('./wallet');
var WalletStore = require('./wallet-store');
var WalletCrypto = require('./wallet-crypto');
var HDAccount = require('./hd-account');
var Transaction = require('./transaction');
var BlockchainAPI = require('./blockchain-api');

  /**
   * @param {?string} note transaction note
   * @param {function()} successCallback success callback function
   * @param {function()} errorCallback error callback function
   * @param {Object} listener callback functions for send progress
   * @param {function(function(string, function, function))} getPassword Get the second password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getPassword function if the right or wrong password was entered.
   */
var Spender = function(note, successCallback, errorCallback, listener, getSecondPassword) {

  assert(successCallback, "success callback required");
  assert(errorCallback, "error callback required");
  if(typeof(listener) == "undefined" || listener == null) {
    listener = {};
  }
  var payment = {
    note:              null,
    fromAddress:       null,
    fromAccountIndex:  null,
    fromAccount:       null,
    amount:            null,
    feeAmount:         null,
    toAddress:         null,
    changeAddress:     null,
    coins:             null,
    secondPassword:    null,
    postSendCB:        null,
    sharedKey:         null,
    pbkdf2_iterations: null,
    getPrivateKeys:    null
  };
  var promises = {
    secondPassword: null,
    coins: null
  };
////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
  var getEncryptionPassword = function(success, error) {
    if (WalletStore.getDoubleEncryption()) {
      getSecondPassword(function(pw, rightCB, wrongCB){
        if (MyWallet.validateSecondPassword(pw)) {
          rightCB();
          success(pw);
        } else {
          wrongCB();
          error("wrong password (promise)");
        }
      });
    } else {
      success(null);
    }
  }
  //////////////////////////////////////////////////////////////////////////////
  var publishTransaction = function(signedTransaction) {

    var succ = function(tx_hash) {
      if(typeof(payment.postSendCB) == "undefined" || payment.postSendCB === null) {
        successCallback(signedTransaction.getId());
      } else {
        payment.postSendCB(signedTransaction);
      }
    };
    BlockchainAPI.push_tx(signedTransaction, payment.note, succ, errorCallback);
  };
  ////////////////////////////////////////////////////////////////////////////////
  var spendCoins = function() {
    // create the transaction (the coins are choosen here)
    var tx = new Transaction( payment.coins, payment.toAddress, payment.amount,
                              payment.feeAmount, payment.changeAddress, listener);
    // obtain the private keys for the coins we are going to spend
    var keys = payment.getPrivateKeys(tx);
    tx.addPrivateKeys(keys);
    tx.randomizeOutputs();
    // sign the transaction
    var signedTransaction = tx.sign();
    // push the transaction to the network
    publishTransaction(signedTransaction);
  }
////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
  var spend = {
    /**
     * @param {string} address to pay
     * @param {function} if present will replace success callback
     */
    toAddress: function(toAddress) {

      assert(toAddress, "to address required");
      // First check if the to address is not part of the from account:
      if(payment.fromAccount && payment.fromAccount.containsAddressInCache(toAddress)) {
        errorCallback("Unable to move bitcoins within the same account.");
      }
      payment.toAddress = toAddress;
      RSVP.hash(promises).then(function(result) {
        payment.secondPassword = result.secondPassword;
        payment.coins = result.coins;
        spendCoins();
      }).catch(errorCallback);
    },
    /**
     * @param {number} index of the account to pay
     */
    toAccount: function(toIndex) {

      assert(toIndex !== undefined || toIndex !== null, "to account index required");
      var toAccount = WalletStore.getHDWallet().getAccount(toIndex);
      var toAddress = toAccount.getReceiveAddress();
      spend.toAddress(toAddress);
    },
    /**
     * @param {string} email address
     */
    toEmail: function(email) {

      assert(email, "to Email required");
      var key = MyWallet.generateNewKey();
      var address = key.pub.getAddress().toString();
      var privateKey = key.toWIF();
      WalletStore.setLegacyAddressTag(address, 2);

      // this is going to be executed after publish transaction
      payment.postSendCB = function(tx){
        var postProcess = function (data) {
          WalletStore.setPaidToElement(tx.getId()
            , {email:email, mobile: null, redeemedAt: null, address: address});
          MyWallet.backupWallet('update', function() {successCallback(tx.getId());});
        }
        BlockchainAPI.sendViaEmail(email, tx, privateKey, postProcess, errorCallback);
      }

      var saveAndSpend = function() {
        MyWallet.backupWallet('update', function() {spend.toAddress(address);});
      }
      var err = function() { console.log('Unexpected error toEmail'); }

      WalletStore.setLegacyAddressLabel(address, email + ' Sent Via Email', saveAndSpend, err);
    },
    /**
     * @param {string} mobile number in int. format, e.g. "+1123555123"
     */
    toMobile: function(mobile) {

      assert(mobile, "to mobile required");
      if (mobile.charAt(0) == '0') { mobile = mobile.substring(1);}
      if (mobile.charAt(0) != '+') { mobile = '+' + mobile;}
      //mobile = '+' + child.find('select[name="sms-country-code"]').val() + mobile;
      var miniKeyAddrobj = MyWallet.generateNewMiniPrivateKey();
      var address = MyWallet.getCompressedAddressString(miniKeyAddrobj.key);
      WalletStore.setLegacyAddressTag(address, 2);

      // this is going to be executed after publish transaction
      payment.postSendCB = function(tx){
        var postProcess = function (data) {
          WalletStore.setPaidToElement(tx.getId()
            , {email:null, mobile: mobile, redeemedAt: null, address: address});

          MyWallet.backupWallet('update', function() {successCallback(tx.getId());});
        }
        BlockchainAPI.sendViaSMS(mobile, tx, miniKeyAddrobj.miniKey, postProcess, errorCallback);
      }

      var saveAndSpend = function() {
        MyWallet.backupWallet('update', function() {spend.toAddress(address);});
      }
      var err = function() { console.log('Unexpected error toMobile'); }

      WalletStore.setLegacyAddressLabel(address, mobile + ' Sent Via SMS', saveAndSpend, err);
    }
  }
  //////////////////////////////////////////////////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////
  var prepareFrom = {
    /**
     * @param {string} fromAddress address from where we are spending
     * @param {number} amount amount to spend
     * @param {number} feeAmount fee to pay
     */
    fromAddress: function(fromAddress, amount, feeAmount) {

      assert(fromAddress, "fromAddress required");
      assert(amount, "amount required");
      assert(feeAmount, "fee required");
      payment.fromAddress = fromAddress ? [fromAddress] : WalletStore.getLegacyActiveAddresses();
      payment.changeAddress = fromAddress || WalletStore.getPreferredLegacyAddress();
      payment.amount = amount;
      payment.feeAmount = feeAmount;

      promises.coins = new RSVP.Promise(function(success, error) {
        MyWallet.getUnspentOutputsForAddresses(payment.fromAddress, success, error);
      });

      // set the private key obtainer function
      payment.getPrivateKeys = function (tx) {
        var getKeyForAddress = function (neededPrivateKeyAddress) {
          var k = WalletStore.getPrivateKey(neededPrivateKeyAddress);
          var privateKeyBase58 = payment.secondPassword === null
            ? k
            : WalletCrypto.decryptSecretWithSecondPassword(
                k, payment.secondPassword, payment.sharedKey, payment.pbkdf2_iterations);
          // TODO If getPrivateKey returns null, it's a watch only address
          // - ask for private key or show error or try again without watch only addresses
          var format = MyWallet.detectPrivateKeyFormat(privateKeyBase58);
          var key = MyWallet.privateKeyStringToKey(privateKeyBase58, format);

          // If the address we looked for is not the public key address of the
          // private key we found, try the compressed address
          if (MyWallet.getCompressedAddressString(key) === neededPrivateKeyAddress) {
            key = new Bitcoin.ECKey(key.d, true);
          }
          return key;
        }
        return tx.addressesOfNeededPrivateKeys.map(getKeyForAddress);
      }

      return spend;
    },
    /**
     * @param {string} fromAddress address from where we are spending
     */
    addressSweep: function(fromAddress) {

      assert(fromAddress, "fromAddress required");
      var feeAmount = MyWallet.getBaseFee();
      var amount = WalletStore.getLegacyAddressBalance(fromAddress) - feeAmount;
      return prepareFrom.fromAddress(fromAddress, amount, feeAmount);
    },
    /**
     * @param {number} fromIndex account index
     * @param {number} amount amount to spend
     * @param {number} feeAmount fee to pay
     */
    fromAccount: function(fromIndex, amount, feeAmount) {

      assert(fromIndex !== undefined || fromIndex !== null, "from account index required");
      assert(amount, "amount required");
      assert(feeAmount, "fee required");
      payment.fromAccountIndex = fromIndex;
      payment.fromAccount = WalletStore.getHDWallet().getAccount(fromIndex);
      payment.changeAddress = payment.fromAccount.getChangeAddress();
      payment.amount = amount;
      payment.feeAmount = feeAmount;

      promises.coins = new RSVP.Promise(function(success, error) {
        MyWallet.getUnspentOutputsForAccount(payment.fromAccountIndex, success, error)
      });

      // set the private key obtainer function
      payment.getPrivateKeys = function (tx) {
        // obtain xpriv
        var extendedPrivateKey = payment.fromAccount.extendedPrivateKey === null || payment.secondPassword === null
          ? payment.fromAccount.extendedPrivateKey
          : WalletCrypto.decryptSecretWithSecondPassword( payment.fromAccount.extendedPrivateKey
                                                        , payment.secondPassword
                                                        , payment.sharedKey
                                                        , payment.pbkdf2_iterations);
        // create an hd-account with xpriv decrypted
        var sendAccount = new HDAccount();
        sendAccount.newNodeFromExtKey(extendedPrivateKey);

        var getKeyForPath = function (neededPrivateKeyPath) {
          return sendAccount.generateKeyFromPath(neededPrivateKeyPath).privKey;
        }
        return tx.pathsOfNeededPrivateKeys.map(getKeyForPath);
      }
      return spend;
    }
  }
  //////////////////////////////////////////////////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////

  promises.secondPassword = new RSVP.Promise(getEncryptionPassword);
  payment.note = note;
  payment.sharedKey = WalletStore.getSharedKey();
  payment.pbkdf2_iterations = WalletStore.getPbkdf2Iterations();
  //////////////////////////////////////////////////////////////////////////////
  return prepareFrom;
}
module.exports = Spender;

// example of usage:
// var getSP = function(tryPassword){setTimeout(function() { tryPassword("hola", function(){console.log("Correct password")}, function(){console.log("Wrong password")})}, 2500)};
// Spender("my note", function(x){console.log("All ok: " +x);}, function(x){console.log("oh fail: " +x);}, null, getSP)
//   .fromAccount(0, 10000000000, 10000).toAddress("1HaxXWGa5cZBUKNLzSWWtyDyRiYLWff8FN");
