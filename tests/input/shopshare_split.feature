Feature: ShopShare Item and Quantity Tracking

  Scenario: Add an item and split its quantity
    Given I navigate to "https://dev.websaleem.com/shopshare/"
    When I click on the "Manual Entry" tab
    And I enter "Pizza" in the item name field
    And I enter "20" in the price field
    And I click the "Add Item" button
    Then I should see "Pizza" in the confirmed items list
    When I click on the "Split Item" button for "Pizza"
    And I set the Total Quantity to "4"
    Then I should see the item quantities correctly allocated
